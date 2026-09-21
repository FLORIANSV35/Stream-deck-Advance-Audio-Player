//! saap-engine : moteur audio du plugin Stream Deck SAAP.
//! Protocole : une commande JSON par ligne sur stdin, un évènement JSON par ligne sur stdout
//! (le même que le moteur macOS, `engine/src/main.m`).

mod audio;
mod voice;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use voice::{Params, Reason, Voice};

fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn num(c: &Value, key: &str, default: f64) -> f64 {
    c.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn params(c: &Value) -> Params {
    Params {
        device: c.get("device").and_then(Value::as_str).unwrap_or("default").to_string(),
        channel: num(c, "channel", 0.0).max(0.0) as usize,
        mono: c.get("mono").and_then(Value::as_bool).unwrap_or(false),
        volume: num(c, "volume", 1.0) as f32,
        looping: c.get("loop").and_then(Value::as_bool).unwrap_or(false),
        fade_in: num(c, "fadeIn", 0.0),
        fade_out: num(c, "fadeOut", 0.0),
        trim_in: num(c, "trimIn", 0.0),
        trim_out: num(c, "trimOut", 0.0),
    }
}

struct Engine {
    voices: HashMap<String, Voice>,
    epoch: Instant,
}

impl Engine {
    fn ended(id: &str, reason: &Reason) {
        match reason {
            Reason::Finished => emit(json!({"evt": "ended", "id": id, "reason": "finished"})),
            Reason::Stopped => emit(json!({"evt": "ended", "id": id, "reason": "stopped"})),
            Reason::Error(m) => emit(json!({"evt": "ended", "id": id, "reason": "error", "message": m})),
        }
    }

    fn fail(id: &str, message: String) {
        emit(json!({"evt": "ended", "id": id, "reason": "error", "message": message}));
    }

    fn start_one(&mut self, c: &Value) {
        let (Some(id), Some(file)) = (c.get("id").and_then(Value::as_str), c.get("file").and_then(Value::as_str)) else { return };
        self.voices.remove(id);
        let result = audio::load(file).and_then(|data| Voice::new(id, data, &params(c), None));
        match result {
            Ok(v) => {
                emit(json!({"evt": "started", "id": id, "duration": v.duration}));
                self.voices.insert(id.to_string(), v);
            }
            Err(m) => Self::fail(id, m),
        }
    }

    /// Lance plusieurs lectures sur un même instant audible.
    fn start_batch(&mut self, items: &[Value]) {
        // décode d'abord chaque fichier une seule fois, en parallèle
        let mut files: Vec<&str> = items.iter().filter_map(|c| c.get("file").and_then(Value::as_str)).collect();
        files.sort_unstable();
        files.dedup();
        std::thread::scope(|s| {
            for f in files {
                s.spawn(move || {
                    let _ = audio::load(f);
                });
            }
        });
        // les flux démarrent en silence, avec un départ « lointain » ; on fixe l'instant commun quand tous tournent
        let far = Instant::now() + Duration::from_secs(30);
        let mut started = Vec::new();
        for c in items {
            let (Some(id), Some(file)) = (c.get("id").and_then(Value::as_str), c.get("file").and_then(Value::as_str)) else { continue };
            self.voices.remove(id);
            match audio::load(file).and_then(|data| Voice::new(id, data, &params(c), Some(far))) {
                Ok(v) => {
                    started.push((id.to_string(), v.duration));
                    self.voices.insert(id.to_string(), v);
                }
                Err(m) => Self::fail(id, m),
            }
        }
        // attend que chaque périphérique ait réellement démarré (une interface USB peut prendre quelques dizaines de ms)
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline
            && started.iter().any(|(id, _)| self.voices.get(id).is_some_and(|v| !v.is_running()))
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        let gate = Instant::now() + Duration::from_millis(80);
        for (id, _) in &started {
            if let Some(v) = self.voices.get(id) {
                v.set_gate(gate);
            }
        }
        for (id, duration) in started {
            emit(json!({"evt": "started", "id": id, "duration": duration}));
        }
    }

    fn ids(&self, c: &Value) -> Vec<String> {
        c.get("ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).filter(|id| self.voices.contains_key(id)).collect())
            .unwrap_or_default()
    }

    /// Déplace / reprend plusieurs lectures ensemble : toutes repartent de la position de la première, au même instant.
    fn seek_many(&self, ids: &[String], c: &Value, resume: bool) {
        let Some(first) = ids.first().and_then(|id| self.voices.get(id)) else { return };
        let target = match c.get("to").and_then(Value::as_f64) {
            Some(t) => t,
            None => first.position() + num(c, "delta", 0.0),
        };
        let gate = Instant::now() + Duration::from_millis(150);
        for id in ids {
            if let Some(v) = self.voices.get(id) {
                v.seek(target, Some(gate), resume);
            }
        }
    }

    fn handle(&mut self, line: &str) -> bool {
        let Ok(c) = serde_json::from_str::<Value>(line) else { return true };
        let Some(cmd) = c.get("cmd").and_then(Value::as_str) else { return true };
        let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let fade = num(&c, "fade", 0.0);
        match cmd {
            "devices" => {
                let list: Vec<Value> = voice::list_devices()
                    .into_iter()
                    .map(|d| json!({"uid": d.uid, "name": d.name, "channels": d.channels}))
                    .collect();
                emit(json!({"evt": "devices", "devices": list}));
            }
            "play" => self.start_one(&c),
            "playBatch" => {
                if let Some(items) = c.get("items").and_then(Value::as_array) {
                    self.start_batch(items);
                }
            }
            "stop" => {
                if let Some(v) = self.voices.get(&id) {
                    v.stop(fade);
                }
            }
            "cut" => {
                if let Some(v) = self.voices.get(&id) {
                    v.cut();
                }
            }
            "pause" => {
                if c.get("ids").is_some() {
                    for i in self.ids(&c) {
                        self.voices[&i].pause();
                    }
                } else if let Some(v) = self.voices.get(&id) {
                    v.pause();
                }
            }
            "resume" => {
                if c.get("ids").is_some() {
                    let ids = self.ids(&c);
                    self.seek_many(&ids, &json!({"delta": 0}), true);
                } else if let Some(v) = self.voices.get(&id) {
                    v.resume();
                }
            }
            "seek" => {
                if c.get("ids").is_some() {
                    let ids = self.ids(&c);
                    self.seek_many(&ids, &c, false);
                } else if let Some(v) = self.voices.get(&id) {
                    let target = c.get("to").and_then(Value::as_f64).unwrap_or_else(|| v.position() + num(&c, "delta", 0.0));
                    v.seek(target, None, false);
                }
            }
            "volume" => {
                if let Some(v) = self.voices.get(&id) {
                    v.set_volume(num(&c, "value", 1.0) as f32);
                }
            }
            "stopAll" => self.voices.values().for_each(|v| v.stop(fade)),
            "cutAll" => self.voices.values().for_each(|v| v.cut()),
            "peaks" => {
                if let (Some(req), Some(file)) = (c.get("req").cloned(), c.get("file").and_then(Value::as_str)) {
                    let (file, n) = (file.to_string(), num(&c, "n", 600.0) as usize);
                    std::thread::spawn(move || match audio::load(&file) {
                        Ok(d) => emit(json!({"evt": "peaks", "req": req, "duration": d.frames as f64 / d.rate, "peaks": audio::peaks(&d, n)})),
                        Err(_) => emit(json!({"evt": "peaks", "req": req, "error": "Fichier illisible"})),
                    });
                }
            }
            "syncInfo" => {
                let items: Vec<Value> = self
                    .voices
                    .values()
                    .map(|v| match v.first_playout() {
                        Some(t) => {
                            let s = t.duration_since(self.epoch).as_secs_f64();
                            json!({"id": v.id, "start": s, "latency": 0.0, "emerges": s})
                        }
                        None => json!({"id": v.id}),
                    })
                    .collect();
                emit(json!({"evt": "syncInfo", "items": items}));
            }
            "quit" => return false,
            _ => {}
        }
        true
    }

    /// Retire les lectures terminées et prévient le plugin.
    fn tick(&mut self) {
        let done: Vec<(String, Reason)> = self.voices.iter().filter_map(|(id, v)| v.finished().map(|r| (id.clone(), r))).collect();
        for (id, reason) in done {
            self.voices.remove(&id);
            Self::ended(&id, &reason);
        }
    }

    fn report_state(&self) {
        for v in self.voices.values() {
            let state = if v.is_paused() { "paused" } else { "playing" };
            emit(json!({"evt": "state", "id": v.id, "state": state, "pos": v.position(), "dur": v.duration}));
        }
    }
}

fn main() {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
        // stdin fermé : le plugin est parti, `tx` est libéré et la boucle principale s'arrête
    });

    let mut engine = Engine { voices: HashMap::new(), epoch: Instant::now() };
    emit(json!({"evt": "ready"}));

    let mut last_state = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => {
                if !engine.handle(&line) {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        engine.tick();
        if last_state.elapsed() >= Duration::from_millis(100) {
            last_state = Instant::now();
            engine.report_state();
        }
    }
}
