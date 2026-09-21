import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";

export interface OutputDevice {
  uid: string;
  name: string;
  channels: number;
}

export interface PeaksResult {
  duration: number;
  peaks: number[];
}

export interface PlayCommand {
  id: string;
  file: string;
  device: string;
  channel: number;
  mono: boolean;
  volume: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  trimIn: number;
  trimOut: number;
}

type EngineEvents = {
  started: [id: string, duration: number];
  state: [id: string, state: "playing" | "paused", pos: number, dur: number];
  ended: [id: string, reason: "finished" | "stopped" | "error", message?: string];
  /** le moteur a redémarré : toutes les lectures en cours sont perdues */
  reset: [];
};

// macOS : moteur natif Objective-C (saap-engine) ; Windows : moteur Rust (saap-engine.exe)
// SAAP_ENGINE : chemin d'un autre moteur (tests)
const ENGINE_PATH =
  process.env.SAAP_ENGINE ?? fileURLToPath(new URL(process.platform === "win32" ? "./saap-engine.exe" : "./saap-engine", import.meta.url));

/**
 * Prépare le binaire du moteur avant de le lancer. Un plugin téléchargé peut arriver sans droit d'exécution,
 * et avec l'étiquette de quarantaine de macOS, qui déclenche « Apple n'a pas pu vérifier… » au premier lancement.
 */
function prepareBinary(): void {
  if (process.platform !== "darwin") return; // quarantaine et droits d'exécution : spécifiques à macOS
  try { chmodSync(ENGINE_PATH, 0o755); } catch { /* déjà correct, ou lecture seule */ }
  try { execFileSync("/usr/bin/xattr", ["-d", "com.apple.quarantine", ENGINE_PATH], { stdio: "ignore" }); } catch { /* pas de quarantaine */ }
}

/** Client du moteur audio natif (processus enfant, JSON ligne par ligne). */
class Engine extends EventEmitter<EngineEvents> {
  #proc?: ChildProcess;
  #devices: OutputDevice[] = [];
  #stopping = false;
  #peakReq = 0;
  #peakWaiters = new Map<number, (r: PeaksResult | undefined) => void>();

  start(): void {
    prepareBinary();
    const proc = spawn(ENGINE_PATH, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.#proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (line) => this.#onLine(line));
    proc.on("error", (e) => streamDeck.logger.error(`Moteur audio : ${e.message}`));
    proc.on("exit", (code) => {
      if (this.#proc !== proc) return;
      this.#proc = undefined;
      if (this.#stopping) return;
      streamDeck.logger.warn(`Moteur audio arrêté (code ${code}), redémarrage`);
      this.emit("reset");
      setTimeout(() => this.start(), 1000);
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#send({ cmd: "quit" });
  }

  #onLine(line: string): void {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.evt) {
      case "devices":
        this.#devices = m.devices;
        break;
      case "peaks": {
        const done = this.#peakWaiters.get(m.req);
        this.#peakWaiters.delete(m.req);
        done?.(m.error ? undefined : { duration: m.duration, peaks: m.peaks });
        break;
      }
      case "started":
        this.emit("started", m.id, m.duration);
        break;
      case "state":
        this.emit("state", m.id, m.state, m.pos, m.dur);
        break;
      case "ended":
        this.emit("ended", m.id, m.reason, m.message);
        break;
    }
  }

  #send(cmd: object): void {
    this.#proc?.stdin?.write(JSON.stringify(cmd) + "\n");
  }

  /** Interroge le moteur et renvoie la liste à jour des périphériques de sortie. */
  async devices(): Promise<OutputDevice[]> {
    const before = this.#devices;
    this.#devices = [];
    this.#send({ cmd: "devices" });
    for (let i = 0; i < 20 && this.#devices.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    if (this.#devices.length === 0) this.#devices = before;
    return this.#devices;
  }

  /** Forme d'onde d'un fichier (n crêtes) ; undefined si illisible ou si le moteur ne répond pas. */
  peaks(file: string, n = 600): Promise<PeaksResult | undefined> {
    const req = ++this.#peakReq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#peakWaiters.delete(req); resolve(undefined); }, 60_000);
      this.#peakWaiters.set(req, (r) => { clearTimeout(timer); resolve(r); });
      this.#send({ cmd: "peaks", req, file, n });
    });
  }

  play(cmd: PlayCommand): void { this.#send({ cmd: "play", ...cmd }); }
  /** Lance plusieurs pistes sur un même instant précis (synchro à moins d'une ms). */
  playBatch(items: PlayCommand[]): void { this.#send({ cmd: "playBatch", items }); }
  stopPlayback(id: string, fade = 0): void { this.#send({ cmd: "stop", id, fade }); }
  cut(id: string): void { this.#send({ cmd: "cut", id }); }
  /** Déplace la lecture de `delta` secondes (négatif = reculer). */
  seek(id: string, delta: number): void { this.#send({ cmd: "seek", id, delta }); }
  /** Déplace plusieurs lectures ensemble : elles repartent toutes de la position de la première, au même instant. */
  seekMany(ids: string[], delta: number): void { this.#send({ cmd: "seek", ids, delta }); }
  pauseMany(ids: string[]): void { this.#send({ cmd: "pause", ids }); }
  /** Reprend plusieurs lectures sur un même instant (et les réaligne). */
  resumeMany(ids: string[]): void { this.#send({ cmd: "resume", ids }); }
  pause(id: string): void { this.#send({ cmd: "pause", id }); }
  resume(id: string): void { this.#send({ cmd: "resume", id }); }
  volume(id: string, value: number): void { this.#send({ cmd: "volume", id, value }); }
}

export const engine = new Engine();
