//! One playback = a dedicated output stream, bound to one device and to specific channels.
//! All the processing (position, fades, volume, routing) happens in the audio callback, sample-accurately.

use std::f32::consts::FRAC_PI_2;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, OutputCallbackInfo, SampleFormat, SizedSample, Stream, StreamConfig};

use crate::audio::AudioData;

#[derive(Clone, Debug, PartialEq)]
pub enum Reason {
    Finished,
    Stopped,
    Error(String),
}

pub struct Params {
    pub device: String,
    pub channel: usize,
    pub mono: bool,
    pub volume: f32,
    pub looping: bool,
    pub fade_in: f64,
    pub fade_out: f64,
    pub trim_in: f64,
    pub trim_out: f64,
    /// loop sub-range within the trim, in seconds; 0/unset falls back to the full trim range
    pub loop_in: f64,
    pub loop_out: f64,
    /// crossfade duration on every wrap: the tail approaching loop_out blends into the head starting at
    /// loop_in, so the seam is masked instead of an audible jump (seconds; 0 = instant wrap, no crossfade)
    pub loop_fade: f64,
}

pub struct DevInfo {
    pub uid: String,
    pub name: String,
    pub channels: usize,
}

/// Output devices. The identifier is the name (suffixed " (2)"… when duplicated).
///
/// macOS goes through `mac_devices` instead of cpal's own `output_devices()`: cpal's CoreAudio
/// backend has a bug that drops any output-only device (built-in speakers, a monitor's
/// DisplayPort audio) from that list — see mac_devices.rs for the full explanation. Windows uses
/// cpal's separate WASAPI backend, which isn't affected.
#[cfg(target_os = "macos")]
pub fn list_devices() -> Vec<DevInfo> {
    crate::mac_devices::output_devices()
        .into_iter()
        .map(|d| DevInfo { uid: d.uid, name: d.name, channels: d.channels })
        .collect()
}

#[cfg(not(target_os = "macos"))]
pub fn list_devices() -> Vec<DevInfo> {
    let host = cpal::default_host();
    let mut result: Vec<DevInfo> = Vec::new();
    let Ok(devices) = host.output_devices() else { return result };
    for dev in devices {
        let Ok(name) = dev.name() else { continue };
        let Ok(cfg) = dev.default_output_config() else { continue };
        let mut uid = name.clone();
        let mut n = 2;
        while result.iter().any(|d| d.uid == uid) {
            uid = format!("{name} ({n})");
            n += 1;
        }
        result.push(DevInfo { uid, name, channels: cfg.channels() as usize });
    }
    result
}

#[cfg(target_os = "macos")]
fn find_device(uid: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if uid == "default" {
        return host.default_output_device().ok_or_else(|| "No default audio output".to_string());
    }
    let native = crate::mac_devices::output_devices();
    let target = native.iter().find(|d| d.uid == uid).ok_or_else(|| format!("Device not found: {uid}"))?;
    // same HAL property, same order, as mac_devices' own raw enumeration — pick the matching
    // cpal Device by position rather than by name (a name doesn't round-trip through cpal's
    // buggy `output_devices()`, but the unfiltered `devices()` list carries every device cpal
    // knows about, in the same order CoreAudio reports them).
    host.devices().map_err(|e| e.to_string())?.nth(target.raw_index).ok_or_else(|| format!("Device not found: {uid}"))
}

#[cfg(not(target_os = "macos"))]
fn find_device(uid: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if uid == "default" {
        return host.default_output_device().ok_or_else(|| "No default audio output".to_string());
    }
    let mut seen: Vec<String> = Vec::new();
    for dev in host.output_devices().map_err(|e| e.to_string())? {
        let Ok(name) = dev.name() else { continue };
        let mut id = name.clone();
        let mut n = 2;
        while seen.contains(&id) {
            id = format!("{name} ({n})");
            n += 1;
        }
        seen.push(id.clone());
        if id == uid {
            return Ok(dev);
        }
    }
    Err(format!("Device not found: {uid}"))
}

struct Ramp {
    from: f32,
    to: f32,
    total: f64,
    done: f64,
    then_stop: bool,
}

struct State {
    data: Arc<AudioData>,
    /// trim bounds and position, in frames of the source file
    start: f64,
    end: f64,
    pos: f64,
    src_rate: f64,
    out_rate: f64,
    /// source frames advanced per output frame (resampling)
    step: f64,
    looping: bool,
    /// loop sub-range within the trim, in frames of the source file
    loop_in: f64,
    loop_out: f64,
    /// true once "exit loop" was requested: the next time playback reaches `loop_out` it continues
    /// straight into the outro (towards `end`) instead of wrapping back to `loop_in`
    exiting: bool,
    /// crossfade duration on every wrap, in seconds (0 = instant wrap, no crossfade)
    loop_fade: f64,
    paused: bool,
    /// silence until this (audible) instant: this is what aligns several playbacks
    gate: Option<Instant>,
    gain: f32,
    cur_gain: f32,
    fade: f32,
    ramp: Option<Ramp>,
    auto_fade_out: f64,
    finished: Option<Reason>,
    ch: usize,
    mono: bool,
    /// audible instant of the first sample played (sync measurement)
    first_playout: Option<Instant>,
    /// number of callbacks received: > 0 = the stream is really running (a USB device can take a while to start)
    callbacks: u64,
}

impl State {
    /// Source frame linearly interpolated at position `p` → (left, right).
    fn frame_at(&self, p: f64) -> (f32, f32) {
        let c = self.data.channels;
        let last = self.data.frames - 1;
        let i0 = (p as usize).min(last);
        let i1 = (i0 + 1).min(last);
        let frac = (p - i0 as f64) as f32;
        let get = |i: usize, k: usize| self.data.samples[i * c + k.min(c - 1)];
        let (l0, l1) = (get(i0, 0), get(i1, 0));
        let (r0, r1) = (get(i0, 1), get(i1, 1));
        (l0 + (l1 - l0) * frac, r0 + (r1 - r0) * frac)
    }

    fn render(&mut self, out: &mut [f32], channels: usize, playout: Instant) {
        self.callbacks += 1;
        if self.finished.is_some() || self.paused {
            return;
        }
        let frames = out.len() / channels;
        let mut first = 0usize;
        if let Some(gate) = self.gate {
            let buffer = Duration::from_secs_f64(frames as f64 / self.out_rate);
            if gate > playout + buffer {
                return; // pas encore l'heure : silence
            }
            if gate > playout {
                first = (((gate - playout).as_secs_f64() * self.out_rate).round() as usize).min(frames);
            }
            self.gate = None;
            if std::env::var_os("SAAP_DEBUG").is_some() {
                let ahead = gate.checked_duration_since(playout).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(-1.0);
                eprintln!("gate consumed: {frames} frames, offset {first}, gate in {ahead:.2} ms");
            }
            if self.first_playout.is_none() {
                self.first_playout = Some(playout + Duration::from_secs_f64(first as f64 / self.out_rate));
            }
        }
        let smooth = 1.0 - (-1.0 / (0.02 * self.out_rate)).exp() as f32;

        for i in first..frames {
            // while looping and not exiting, the wrap point is `loop_out`; otherwise (not looping, or
            // exiting the loop) it is `end`. Flipping `exiting` just changes this boundary: the current
            // iteration keeps playing and, next time it would have wrapped, it instead sails through into
            // the outro — no special-casing of "already mid-iteration" is needed.
            let looping_now = self.looping && !self.exiting;
            // Crossfade: instead of hard-cutting at loop_out, keep reading `loop_fade` seconds of tail
            // material *past* it (this is why fade is clamped to leave that much room before `end`) and
            // blend it with the head starting at loop_in, then switch to loop_in + fade once the tail is
            // exhausted. This is what keeps the loop's rhythmic length exactly loop_out - loop_in: the
            // normal segment of the *next* iteration is shorter by `fade`, but the crossfade itself still
            // takes `fade` seconds of output, so nothing is lost — cutting the crossfade entirely before
            // loop_out instead (no tail read) would shrink each iteration by `fade`, drifting the loop's
            // tempo, which is why it's done this way round.
            let fade_frames = if looping_now { self.loop_fade * self.src_rate } else { 0.0 };
            if !looping_now && self.pos >= self.end {
                self.finished = Some(Reason::Finished);
                break;
            }
            if looping_now && self.pos >= self.loop_out + fade_frames {
                self.pos = self.loop_in + fade_frames + (self.pos - (self.loop_out + fade_frames));
            }
            let (l, r) = if fade_frames > 0.0 && self.pos >= self.loop_out && self.pos < self.loop_out + fade_frames {
                // blend the tail past loop_out (primary, fading out) with the head from loop_in (secondary,
                // fading in), in sync — dropped instantly if `exiting` flips mid-crossfade (fade_frames then
                // reads 0 above), which is seamless here since the primary side is already genuine tail
                // content continuing naturally into the outro, unlike a switch-over that would need undoing
                let (pl, pr) = self.frame_at(self.pos);
                let sec_pos = self.loop_in + (self.pos - self.loop_out);
                let (sl, sr) = self.frame_at(sec_pos);
                let p = ((self.pos - self.loop_out) / fade_frames) as f32;
                let (out_g, in_g) = ((p * FRAC_PI_2).cos(), (p * FRAC_PI_2).sin());
                (pl * out_g + sl * in_g, pr * out_g + sr * in_g)
            } else {
                self.frame_at(self.pos)
            };

            // fade in progress (sine/cosine: constant power)
            if let Some(mut rp) = self.ramp.take() {
                rp.done += 1.0;
                let p = (rp.done / rp.total).min(1.0) as f32;
                self.fade = if rp.to > rp.from {
                    rp.from + (rp.to - rp.from) * (p * FRAC_PI_2).sin()
                } else {
                    rp.to + (rp.from - rp.to) * (p * FRAC_PI_2).cos()
                };
                if p >= 1.0 {
                    self.fade = rp.to;
                    if rp.then_stop {
                        self.finished = Some(Reason::Stopped);
                        break;
                    }
                } else {
                    self.ramp = Some(rp);
                }
            }
            // automatic fade out before the end of the file — only on the final pass (not looping,
            // or looping but exiting), since during regular loop iterations there is no upcoming `end`
            let mut auto = 1.0f32;
            if !looping_now && self.auto_fade_out > 0.0 {
                let remaining = (self.end - self.pos) / self.src_rate;
                if remaining <= self.auto_fade_out {
                    let p = (1.0 - remaining / self.auto_fade_out).clamp(0.0, 1.0) as f32;
                    auto = (p * FRAC_PI_2).cos();
                }
            }
            self.cur_gain += (self.gain - self.cur_gain) * smooth;
            let g = self.cur_gain * self.fade * auto;

            let base = i * channels;
            if channels == 1 {
                out[base] = (l + r) * 0.5 * g;
            } else if self.mono {
                if self.ch < channels {
                    out[base + self.ch] = (l + r) * 0.5 * g;
                }
            } else {
                if self.ch < channels {
                    out[base + self.ch] = l * g;
                }
                if self.ch + 1 < channels {
                    out[base + self.ch + 1] = r * g;
                }
            }
            self.pos += self.step;
        }
    }
}

pub struct Voice {
    pub id: String,
    pub duration: f64,
    shared: Arc<Mutex<State>>,
    _stream: Stream,
}

impl Voice {
    /// `gate`: audible start instant (None = right away).
    pub fn new(id: &str, data: Arc<AudioData>, p: &Params, gate: Option<Instant>) -> Result<Voice, String> {
        let device = find_device(&p.device)?;
        // macOS: derive the config from CoreAudio directly rather than cpal's
        // `default_output_config()`, which hits the same enumeration bug as list_devices() (see
        // mac_devices.rs) for any output-only device. Building the stream itself is unaffected.
        #[cfg(target_os = "macos")]
        let (format, stream_config): (SampleFormat, StreamConfig) = {
            let (channels, rate) = if p.device == "default" {
                crate::mac_devices::default_device_config()
            } else {
                crate::mac_devices::output_devices().into_iter().find(|d| d.uid == p.device).map(|d| (d.channels, d.sample_rate))
            }
            .ok_or_else(|| "Unusable output: device not found".to_string())?;
            (SampleFormat::F32, StreamConfig { channels: channels as u16, sample_rate: cpal::SampleRate(rate as u32), buffer_size: cpal::BufferSize::Default })
        };
        #[cfg(not(target_os = "macos"))]
        let (format, stream_config): (SampleFormat, StreamConfig) = {
            let config = device.default_output_config().map_err(|e| format!("Unusable output: {e}"))?;
            (config.sample_format(), config.config())
        };
        let out_rate = stream_config.sample_rate.0 as f64;

        let src_rate = data.rate;
        let start = (p.trim_in * src_rate).clamp(0.0, data.frames as f64);
        let end = if p.trim_out > 0.0 { (p.trim_out * src_rate).min(data.frames as f64) } else { data.frames as f64 };
        if end <= start + 1.0 {
            return Err("Invalid trim points".to_string());
        }
        // loop sub-range within the trim; 0/unset or an invalid range falls back to the full trim
        // (this is also what makes existing "loop the whole trim" settings keep working unchanged)
        let mut loop_in = if p.loop_in > 0.0 { (p.loop_in * src_rate).clamp(start, end) } else { start };
        let mut loop_out = if p.loop_out > 0.0 { (p.loop_out * src_rate).clamp(start, end) } else { end };
        if loop_out <= loop_in + 1.0 {
            loop_in = start;
            loop_out = end;
        }
        // clamp to at most the loop length (longer would make the switch-over position overshoot loop_out,
        // leaving no dry segment at all) and to however much source material actually exists past loop_out
        // to read as the crossfade's tail (there may be little to none if loop_out sits near `end`)
        let loop_fade = p.loop_fade.max(0.0).min((loop_out - loop_in) / src_rate).min((end - loop_out) / src_rate);
        let gain = p.volume.clamp(0.0, 1.0);
        let mut state = State {
            data,
            start,
            end,
            pos: start,
            src_rate,
            out_rate,
            step: src_rate / out_rate,
            looping: p.looping,
            loop_in,
            loop_out,
            exiting: false,
            loop_fade,
            paused: false,
            gate,
            gain,
            cur_gain: gain,
            fade: 1.0,
            ramp: None,
            auto_fade_out: p.fade_out,
            finished: None,
            ch: p.channel,
            mono: p.mono,
            first_playout: None,
            callbacks: 0,
        };
        if p.fade_in > 0.0 {
            state.fade = 0.0;
            state.ramp = Some(Ramp { from: 0.0, to: 1.0, total: (p.fade_in * out_rate).max(1.0), done: 0.0, then_stop: false });
        }
        let duration = (end - start) / src_rate;
        let shared = Arc::new(Mutex::new(state));

        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, &stream_config, &shared),
            SampleFormat::I16 => build::<i16>(&device, &stream_config, &shared),
            SampleFormat::I32 => build::<i32>(&device, &stream_config, &shared),
            SampleFormat::U16 => build::<u16>(&device, &stream_config, &shared),
            other => Err(format!("Unsupported audio format: {other:?}")),
        }?;
        stream.play().map_err(|e| format!("Cannot start audio: {e}"))?;
        Ok(Voice { id: id.to_string(), duration, shared, _stream: stream })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Position within the trim, in seconds.
    pub fn position(&self) -> f64 {
        let s = self.lock();
        ((s.pos.min(s.end) - s.start) / s.src_rate).max(0.0)
    }

    /// The stream received its first callback: the common start instant can be set.
    pub fn is_running(&self) -> bool {
        self.lock().callbacks > 0
    }

    pub fn set_gate(&self, gate: Instant) {
        self.lock().gate = Some(gate);
    }

    pub fn is_paused(&self) -> bool {
        self.lock().paused
    }

    pub fn is_looping(&self) -> bool {
        self.lock().looping
    }

    /// True once "exit loop" was requested for this playback.
    pub fn is_exiting(&self) -> bool {
        self.lock().exiting
    }

    /// Stops wrapping back to `loop_in`: playback finishes the current iteration, then continues
    /// straight through the outro to the end of the trim. No-op if this playback is not looping.
    pub fn exit_loop(&self) {
        self.lock().exiting = true;
    }

    pub fn finished(&self) -> Option<Reason> {
        self.lock().finished.clone()
    }

    pub fn first_playout(&self) -> Option<Instant> {
        self.lock().first_playout
    }

    pub fn set_volume(&self, v: f32) {
        self.lock().gain = v.clamp(0.0, 1.0);
    }

    pub fn pause(&self) {
        self.lock().paused = true;
    }

    pub fn resume(&self) {
        self.lock().paused = false;
    }

    /// Stop with a fade out (0 = immediate cut).
    pub fn stop(&self, fade_seconds: f64) {
        let mut s = self.lock();
        if fade_seconds <= 0.0 {
            s.finished = Some(Reason::Stopped);
            return;
        }
        s.paused = false;
        let from = s.fade;
        let total = (fade_seconds * s.out_rate).max(1.0);
        s.ramp = Some(Ramp { from, to: 0.0, total, done: 0.0, then_stop: true });
    }

    pub fn cut(&self) {
        self.lock().finished = Some(Reason::Stopped);
    }

    /// Moves playback to `seconds` (within the trim). `gate`: resume at an exact instant; `resume`: leaves the paused state.
    pub fn seek(&self, seconds: f64, gate: Option<Instant>, resume: bool) {
        let mut s = self.lock();
        let len = (s.end - s.start) / s.src_rate;
        let mut t = seconds;
        if s.looping && len > 0.0 {
            t = t.rem_euclid(len);
        } else if t >= len - 0.02 {
            s.finished = Some(Reason::Finished);
            return;
        }
        s.pos = s.start + t.max(0.0) * s.src_rate;
        if resume {
            s.paused = false;
        }
        if gate.is_some() {
            s.gate = gate;
        }
        // moved back before the fade-out zone: nothing to cancel, it is recomputed every sample
    }
}

fn build<T>(device: &cpal::Device, config: &StreamConfig, shared: &Arc<Mutex<State>>) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let data_state = shared.clone();
    let err_state = shared.clone();
    let mut scratch: Vec<f32> = Vec::new();
    device
        .build_output_stream(
            config,
            move |out: &mut [T], info: &OutputCallbackInfo| {
                scratch.clear();
                scratch.resize(out.len(), 0.0);
                if let Ok(mut st) = data_state.try_lock() {
                    // instant at which this buffer will actually be audible
                    let ts = info.timestamp();
                    let delay = ts.playback.duration_since(&ts.callback).unwrap_or_default();

                    st.render(&mut scratch, channels, Instant::now() + delay);
                }
                for (o, s) in out.iter_mut().zip(scratch.iter()) {
                    *o = T::from_sample(*s);
                }
            },
            move |err| {
                if let Ok(mut st) = err_state.lock() {
                    st.finished = Some(Reason::Error(err.to_string()));
                }
            },
            None,
        )
        .map_err(|e| format!("Cannot use the output: {e}"))
}
