//! Décodage des fichiers en mémoire (avec cache) et calcul de la forme d'onde.

use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Fichier décodé : échantillons flottants entrelacés.
pub struct AudioData {
    pub samples: Vec<f32>,
    pub channels: usize,
    pub rate: f64,
    pub frames: usize,
}

type CacheEntry = (String, SystemTime, Arc<AudioData>);

/// Charge un fichier (décodé une seule fois tant qu'il ne change pas ; 12 fichiers gardés en mémoire).
pub fn load(path: &str) -> Result<Arc<AudioData>, String> {
    static CACHE: OnceLock<Mutex<Vec<CacheEntry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|_| format!("Fichier introuvable : {path}"))?;

    {
        let mut c = cache.lock().unwrap();
        if let Some(i) = c.iter().position(|e| e.0 == path && e.1 == mtime) {
            let entry = c.remove(i);
            let data = entry.2.clone();
            c.push(entry); // le plus récemment utilisé en dernier
            return Ok(data);
        }
    }
    let data = Arc::new(decode(path)?);
    let mut c = cache.lock().unwrap();
    c.retain(|e| e.0 != path);
    c.push((path.to_string(), mtime, data.clone()));
    while c.len() > 12 {
        c.remove(0);
    }
    Ok(data)
}

fn decode(path: &str) -> Result<AudioData, String> {
    let bad = || format!("Fichier illisible : {path}");
    let file = File::open(path).map_err(|_| bad())?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|_| bad())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or_else(bad)?;
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.ok_or_else(bad)? as f64;
    let mut channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(0);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| bad())?;

    let mut samples: Vec<f32> = Vec::new();
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(_)) | Err(Error::ResetRequired) => break, // fin de fichier
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if channels == 0 {
                    channels = spec.channels.count();
                }
                let needed = decoded.capacity() as u64;
                if buffer.as_ref().map_or(true, |b| (b.capacity() as u64) < needed * spec.channels.count() as u64) {
                    buffer = Some(SampleBuffer::<f32>::new(needed, spec));
                }
                let b = buffer.as_mut().unwrap();
                b.copy_interleaved_ref(decoded);
                samples.extend_from_slice(b.samples());
            }
            Err(Error::DecodeError(_)) => continue, // paquet abîmé : on saute
            Err(_) => break,
        }
    }
    if channels == 0 || samples.is_empty() {
        return Err(bad());
    }
    let frames = samples.len() / channels;
    samples.truncate(frames * channels);
    Ok(AudioData { samples, channels, rate, frames })
}

/// Crête (valeur absolue max, tous canaux) de chacune des `n` tranches du fichier.
pub fn peaks(d: &AudioData, n: usize) -> Vec<f32> {
    let n = n.clamp(10, 4000);
    let mut out = vec![0f32; n];
    for (f, frame) in d.samples.chunks_exact(d.channels).enumerate() {
        let idx = ((f as u64 * n as u64) / d.frames as u64) as usize;
        let idx = idx.min(n - 1);
        for s in frame {
            let v = s.abs();
            if v > out[idx] {
                out[idx] = v;
            }
        }
    }
    out.iter().map(|v| (v.min(1.0) * 1000.0).round() / 1000.0).collect()
}
