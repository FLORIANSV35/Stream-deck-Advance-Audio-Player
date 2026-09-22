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
    /// fade out approaching loop_out, mirrored as a fade in just after loop_in, on every wrap (seconds)
    pub loop_fade: f64,
}

pub struct DevInfo {
    pub uid: String,
    pub name: String,
    pub channels: usize,
}

/// Output devices. The identifier is the name (suffixed " (2)"… when duplicated).
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
    /// seconds of fade approaching loop_out / following loop_in, on every wrap (0 = no fade, instant wrap)
    loop_fade: f64,
    /// true once the first wrap has happened: distinguishes "intro passing through loop_in on its way to
    /// loop_out" (no fade-in wanted) from "just wrapped back to loop_in" (fade-in wanted)
    wrapped_once: bool,
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
            let wrap_at = if looping_now { self.loop_out } else { self.end };
            if self.pos >= wrap_at {
                if looping_now {
                    self.pos = self.loop_in + (self.pos - self.loop_out);
                    self.wrapped_once = true;
                } else {
                    self.finished = Some(Reason::Finished);
                    break;
                }
            }
            let (l, r) = self.frame_at(self.pos);

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
            // fade approaching the wrap point, mirrored just after it — masks the click of a non-zero-
            // crossing loop point. Purely a function of position (like `auto` above), not a stateful ramp,
            // so it stays correct regardless of exactly when a wrap happened.
            let mut loop_env = 1.0f32;
            if looping_now && self.loop_fade > 0.0 {
                let to_wrap = (self.loop_out - self.pos) / self.src_rate;
                if to_wrap <= self.loop_fade {
                    let p = (1.0 - (to_wrap / self.loop_fade).max(0.0)) as f32;
                    loop_env = (p * FRAC_PI_2).cos();
                }
                if self.wrapped_once {
                    let since_in = (self.pos - self.loop_in) / self.src_rate;
                    if (0.0..=self.loop_fade).contains(&since_in) {
                        let p = (since_in / self.loop_fade) as f32;
                        loop_env = loop_env.min((p * FRAC_PI_2).sin());
                    }
                }
            }
            self.cur_gain += (self.gain - self.cur_gain) * smooth;
            let g = self.cur_gain * self.fade * auto * loop_env;

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
        let config = device.default_output_config().map_err(|e| format!("Unusable output: {e}"))?;
        let format = config.sample_format();
        let stream_config: StreamConfig = config.config();
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
        // clamp so the fade-out and fade-in zones never overlap: the loop always has a moment at full volume
        let loop_fade = p.loop_fade.max(0.0).min((loop_out - loop_in) / src_rate / 2.0);
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
            wrapped_once: false,
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
