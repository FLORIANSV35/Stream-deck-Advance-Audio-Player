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
  /** loop sub-range within the trim; 0/unset = loop the whole trim */
  loopIn: number;
  loopOut: number;
  /** crossfade duration (s) on every wrap: the tail past loopOut blends into the head at loopIn; 0 = instant wrap */
  loopFade: number;
}

type EngineEvents = {
  started: [id: string, duration: number];
  state: [id: string, state: "playing" | "paused", pos: number, dur: number, looping: boolean, exiting: boolean];
  ended: [id: string, reason: "finished" | "stopped" | "error", message?: string];
  /** the engine restarted: all running playbacks are lost */
  reset: [];
  /** a preload()'d file has been read through once (OS file cache now warm for it) */
  preloaded: [file: string];
  /** a warm()'d device's silent stream has started */
  warmed: [device: string];
};

// macOS: native Objective-C engine (saap-engine); Windows: Rust engine (saap-engine.exe)
// SAAP_ENGINE: path to another engine (tests)
const ENGINE_PATH =
  process.env.SAAP_ENGINE ?? fileURLToPath(new URL(process.platform === "win32" ? "./saap-engine.exe" : "./saap-engine", import.meta.url));

/**
 * Prepares the engine binary before launching it. A downloaded plugin may arrive without the execute bit,
 * and with the macOS quarantine flag, which triggers "Apple could not verify…" on first launch.
 */
function prepareBinary(): void {
  if (process.platform !== "darwin") return; // quarantine and execute bit: macOS only
  try { chmodSync(ENGINE_PATH, 0o755); } catch { /* already correct, or read-only */ }
  try { execFileSync("/usr/bin/xattr", ["-d", "com.apple.quarantine", ENGINE_PATH], { stdio: "ignore" }); } catch { /* no quarantine flag */ }
}

/** Client of the native audio engine (child process, one JSON message per line). */
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
    proc.on("error", (e) => streamDeck.logger.error(`Audio engine: ${e.message}`));
    proc.on("exit", (code) => {
      if (this.#proc !== proc) return;
      this.#proc = undefined;
      if (this.#stopping) return;
      streamDeck.logger.warn(`Audio engine stopped (code ${code}), restarting`);
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
        this.emit("state", m.id, m.state, m.pos, m.dur, !!m.looping, !!m.exiting);
        break;
      case "ended":
        this.emit("ended", m.id, m.reason, m.message);
        break;
      case "preloaded":
        this.emit("preloaded", m.file);
        break;
      case "warmed":
        this.emit("warmed", m.device);
        break;
    }
  }

  #send(cmd: object): void {
    this.#proc?.stdin?.write(JSON.stringify(cmd) + "\n");
  }

  /** Asks the engine for the up-to-date list of output devices. */
  async devices(): Promise<OutputDevice[]> {
    const before = this.#devices;
    this.#devices = [];
    this.#send({ cmd: "devices" });
    for (let i = 0; i < 20 && this.#devices.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    if (this.#devices.length === 0) this.#devices = before;
    return this.#devices;
  }

  /** Waveform of a file (n peaks); undefined if unreadable or if the engine does not answer. */
  peaks(file: string, n = 600): Promise<PeaksResult | undefined> {
    const req = ++this.#peakReq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#peakWaiters.delete(req); resolve(undefined); }, 60_000);
      this.#peakWaiters.set(req, (r) => { clearTimeout(timer); resolve(r); });
      this.#send({ cmd: "peaks", req, file, n });
    });
  }

  /**
   * Pre-starts a silent stream on this output device, if not already running. Some audio interfaces take a real
   * couple of seconds to power up the first time a stream starts on them, and whatever plays during that window is
   * lost; warming a device well ahead of an actual Play press (see PlayAction) avoids that cutting into real audio.
   */
  warm(device: string): void { this.#send({ cmd: "warm", device }); }
  /** Reads a file through once in the background, purely so the OS file cache is warm by the time Play actually
   * needs it — a cold read otherwise cuts into the very start of playback, same idea as warm() for a device. */
  preload(file: string): void { this.#send({ cmd: "preload", file }); }
  play(cmd: PlayCommand): void { this.#send({ cmd: "play", ...cmd }); }
  /** Starts several tracks at one exact instant (synchronized within a millisecond). */
  playBatch(items: PlayCommand[]): void { this.#send({ cmd: "playBatch", items }); }
  stopPlayback(id: string, fade = 0): void { this.#send({ cmd: "stop", id, fade }); }
  cut(id: string): void { this.#send({ cmd: "cut", id }); }
  /** Moves playback by `delta` seconds (negative = backwards). */
  seek(id: string, delta: number): void { this.#send({ cmd: "seek", id, delta }); }
  /** Moves several playbacks together: all restart from the position of the first one, at the same instant. */
  seekMany(ids: string[], delta: number): void { this.#send({ cmd: "seek", ids, delta }); }
  pauseMany(ids: string[]): void { this.#send({ cmd: "pause", ids }); }
  /** Resumes several playbacks at the same instant (and realigns them). */
  resumeMany(ids: string[]): void { this.#send({ cmd: "resume", ids }); }
  pause(id: string): void { this.#send({ cmd: "pause", id }); }
  resume(id: string): void { this.#send({ cmd: "resume", id }); }
  volume(id: string, value: number): void { this.#send({ cmd: "volume", id, value }); }
  /** Stops wrapping back to loopIn: playback finishes the current iteration, then plays through to trimOut. */
  exitLoop(id: string): void { this.#send({ cmd: "exitLoop", id }); }
  /** Same, for several playbacks (e.g. all the tracks of a key, or a whole group). */
  exitLoopMany(ids: string[]): void { this.#send({ cmd: "exitLoop", ids }); }
}

export const engine = new Engine();
