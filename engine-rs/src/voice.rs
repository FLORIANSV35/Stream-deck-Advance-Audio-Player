//! Une lecture = un flux de sortie dédié, lié à un périphérique et à des canaux précis.
//! Tout le traitement (position, fondus, volume, routage) se fait dans le callback audio, à l'échantillon près.

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
}

pub struct DevInfo {
    pub uid: String,
    pub name: String,
    pub channels: usize,
}

/// Périphériques de sortie. L'identifiant est le nom (suffixé « (2) »… en cas de doublon).
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
        return host.default_output_device().ok_or_else(|| "Aucune sortie audio par défaut".to_string());
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
    Err(format!("Périphérique introuvable : {uid}"))
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
    /// bornes de la découpe et position, en trames du fichier source
    start: f64,
    end: f64,
    pos: f64,
    src_rate: f64,
    out_rate: f64,
    /// trames source avancées par trame de sortie (rééchantillonnage)
    step: f64,
    looping: bool,
    paused: bool,
    /// silence jusqu'à cet instant (audible) : c'est ce qui aligne plusieurs lectures
    gate: Option<Instant>,
    gain: f32,
    cur_gain: f32,
    fade: f32,
    ramp: Option<Ramp>,
    auto_fade_out: f64,
    finished: Option<Reason>,
    ch: usize,
    mono: bool,
    /// instant audible du premier échantillon joué (mesure de synchro)
    first_playout: Option<Instant>,
    /// nombre de callbacks reçus : > 0 = le flux tourne vraiment (un périphérique USB peut mettre du temps à démarrer)
    callbacks: u64,
}

impl State {
    /// Trame source interpolée linéairement à la position `p` → (gauche, droite).
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
                eprintln!("gate consommée : {frames} trames, décalage {first}, gate dans {ahead:.2} ms");
            }
            if self.first_playout.is_none() {
                self.first_playout = Some(playout + Duration::from_secs_f64(first as f64 / self.out_rate));
            }
        }
        let smooth = 1.0 - (-1.0 / (0.02 * self.out_rate)).exp() as f32;

        for i in first..frames {
            if self.pos >= self.end {
                if self.looping {
                    self.pos = self.start + (self.pos - self.end);
                } else {
                    self.finished = Some(Reason::Finished);
                    break;
                }
            }
            let (l, r) = self.frame_at(self.pos);

            // fondu en cours (sinus/cosinus : puissance constante)
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
            // fondu de sortie automatique avant la fin du fichier
            let mut auto = 1.0f32;
            if !self.looping && self.auto_fade_out > 0.0 {
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
    /// `gate` : instant audible de départ (None = tout de suite).
    pub fn new(id: &str, data: Arc<AudioData>, p: &Params, gate: Option<Instant>) -> Result<Voice, String> {
        let device = find_device(&p.device)?;
        let config = device.default_output_config().map_err(|e| format!("Sortie inutilisable : {e}"))?;
        let format = config.sample_format();
        let stream_config: StreamConfig = config.config();
        let out_rate = stream_config.sample_rate.0 as f64;

        let src_rate = data.rate;
        let start = (p.trim_in * src_rate).clamp(0.0, data.frames as f64);
        let end = if p.trim_out > 0.0 { (p.trim_out * src_rate).min(data.frames as f64) } else { data.frames as f64 };
        if end <= start + 1.0 {
            return Err("Points de découpe invalides".to_string());
        }
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
            other => Err(format!("Format audio non géré : {other:?}")),
        }?;
        stream.play().map_err(|e| format!("Démarrage audio impossible : {e}"))?;
        Ok(Voice { id: id.to_string(), duration, shared, _stream: stream })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Position dans la découpe, en secondes.
    pub fn position(&self) -> f64 {
        let s = self.lock();
        ((s.pos.min(s.end) - s.start) / s.src_rate).max(0.0)
    }

    /// Le flux a reçu son premier callback : on peut fixer l'instant de départ commun.
    pub fn is_running(&self) -> bool {
        self.lock().callbacks > 0
    }

    pub fn set_gate(&self, gate: Instant) {
        self.lock().gate = Some(gate);
    }

    pub fn is_paused(&self) -> bool {
        self.lock().paused
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

    /// Arrêt avec fondu de sortie (0 = coupure immédiate).
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

    /// Déplace la lecture à `seconds` (dans la découpe). `gate` : reprise à un instant précis ; `resume` : sort de la pause.
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
        // revenu avant la zone du fondu de fin : rien à annuler, il est recalculé à chaque échantillon
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
                    // instant où ce tampon sera réellement audible
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
        .map_err(|e| format!("Impossible d'utiliser la sortie : {e}"))
}
