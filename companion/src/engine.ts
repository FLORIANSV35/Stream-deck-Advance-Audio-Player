import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";

export interface OutputDevice {
  uid: string;
  name: string;
  channels: number;
}

export interface PeaksResult {
  duration: number;
  from: number;
  to: number;
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
  loopIn: number;
  loopOut: number;
  loopFade: number;
}

type EngineEvents = {
  started: [id: string, duration: number];
  state: [id: string, state: "playing" | "paused", pos: number, dur: number, looping: boolean, exiting: boolean];
  ended: [id: string, reason: "finished" | "stopped" | "error", message?: string];
  reset: [];
  preloaded: [file: string];
};

/** Same native binary and JSON-line protocol as the Stream Deck plugin (see plugin/src/engine.ts) — bundled
 * separately here (companion/bin) so this module has no runtime dependency on the plugin being installed. */
function enginePath(root: string): string {
  return join(root, "bin", process.platform === "win32" ? "saap-engine.exe" : "saap-engine");
}

/** A downloaded/unzipped module arrives without the execute bit, and on macOS with the quarantine flag, which
 * triggers "Apple could not verify…" on first launch — same dance as the Stream Deck plugin's prepareBinary(). */
function prepareBinary(path: string): void {
  if (process.platform !== "darwin") return;
  try { chmodSync(path, 0o755); } catch { /* already correct, or read-only */ }
  try { execFileSync("/usr/bin/xattr", ["-d", "com.apple.quarantine", path], { stdio: "ignore" }); } catch { /* no quarantine flag */ }
}

/** Client of the native audio engine (child process, one JSON message per line). */
export class Engine extends EventEmitter<EngineEvents> {
  readonly #root: string;
  readonly #log: (msg: string) => void;
  #proc?: ChildProcess;
  #devices: OutputDevice[] = [];
  #stopping = false;
  #peakReq = 0;
  #peakWaiters = new Map<number, (r: PeaksResult | undefined) => void>();

  constructor(root: string, log: (msg: string) => void) {
    super();
    this.#root = root;
    this.#log = log;
  }

  start(): void {
    const path = enginePath(this.#root);
    prepareBinary(path);
    const proc = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.#proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (line) => this.#onLine(line));
    proc.on("error", (e) => this.#log(`Audio engine: ${e.message}`));
    proc.on("exit", (code) => {
      if (this.#proc !== proc) return;
      this.#proc = undefined;
      if (this.#stopping) return;
      this.#log(`Audio engine stopped (code ${code}), restarting`);
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
        done?.(m.error ? undefined : { duration: m.duration, from: m.from, to: m.to, peaks: m.peaks });
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
      case "log":
        this.#log(`[engine] ${m.message}`);
        break;
    }
  }

  #send(cmd: object): void {
    this.#proc?.stdin?.write(JSON.stringify(cmd) + "\n");
  }

  async devices(): Promise<OutputDevice[]> {
    const before = this.#devices;
    this.#devices = [];
    this.#send({ cmd: "devices" });
    for (let i = 0; i < 20 && this.#devices.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    if (this.#devices.length === 0) this.#devices = before;
    return this.#devices;
  }

  /** Waveform of a file (n peaks over [from, to), or the whole file if omitted); undefined if unreadable or if
   * the engine does not answer. */
  peaks(file: string, n = 600, from = 0, to = 0): Promise<PeaksResult | undefined> {
    const req = ++this.#peakReq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#peakWaiters.delete(req); resolve(undefined); }, 60_000);
      this.#peakWaiters.set(req, (r) => { clearTimeout(timer); resolve(r); });
      this.#send({ cmd: "peaks", req, file, n, from, to });
    });
  }

  preload(file: string): void { this.#send({ cmd: "preload", file }); }
  play(cmd: PlayCommand): void { this.#send({ cmd: "play", ...cmd }); }
  playBatch(items: PlayCommand[]): void { this.#send({ cmd: "playBatch", items }); }
  stopPlayback(id: string, fade = 0): void { this.#send({ cmd: "stop", id, fade }); }
  cut(id: string): void { this.#send({ cmd: "cut", id }); }
  seek(id: string, delta: number): void { this.#send({ cmd: "seek", id, delta }); }
  seekMany(ids: string[], delta: number): void { this.#send({ cmd: "seek", ids, delta }); }
  pauseMany(ids: string[]): void { this.#send({ cmd: "pause", ids }); }
  resumeMany(ids: string[]): void { this.#send({ cmd: "resume", ids }); }
  pause(id: string): void { this.#send({ cmd: "pause", id }); }
  resume(id: string): void { this.#send({ cmd: "resume", id }); }
  volume(id: string, value: number): void { this.#send({ cmd: "volume", id, value }); }
  exitLoop(id: string): void { this.#send({ cmd: "exitLoop", id }); }
  exitLoopMany(ids: string[]): void { this.#send({ cmd: "exitLoop", ids }); }
  stopAll(fade = 0): void { this.#send({ cmd: "stopAll", fade }); }
  cutAll(): void { this.#send({ cmd: "cutAll" }); }
}
