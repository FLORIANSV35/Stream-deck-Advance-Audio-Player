import { EventEmitter } from "node:events";
import type { Engine, PlayCommand } from "./engine.js";
import { resolvePath } from "./filepicker.js";
import { mixer } from "./mixer.js";
import { trackOutputs } from "./outputs.js";
import { gainFor, inGroup, keyOf, playbacks, trackOf, type Playback } from "./registry.js";
import { MAX_TRACKS, seconds, trackSettings, type PlaySettings } from "./settings.js";
import type { Store } from "./store.js";

type PlayerEvents = {
  /** a sound started/stopped/ended: feedbacks for that sound id should re-check */
  changed: [soundId: string];
  /** live position, ~10×/s, forwarded to the web editor's waveform cursor */
  position: [soundId: string, track: number, playing: boolean, pos: number, dur: number];
};

/** The tracks of a sound have the id "<soundId>#<n>" on the engine side (one entry per output). */
export const tracksOf = (soundId: string): Playback[] => [...playbacks.values()].filter((p) => keyOf(p.id) === soundId);

/**
 * Turns a sound's stored settings into engine commands and keeps the `playbacks` registry in sync with what the
 * engine reports — the Companion equivalent of the Stream Deck plugin's PlayAction (plugin/src/actions/play.ts),
 * minus everything tied to Stream Deck keys/panels (rendering, prewarm-on-appear, remote triggers).
 */
export class Player extends EventEmitter<PlayerEvents> {
  readonly #engine: Engine;
  readonly #store: Store;
  readonly #log: (msg: string) => void;
  #everWarmed = new Set<string>();
  #requested = new Map<string, number>();

  constructor(engine: Engine, store: Store, log: (msg: string) => void) {
    super();
    this.#engine = engine;
    this.#store = store;
    this.#log = log;

    engine.on("started", (id, duration) => {
      const p = playbacks.get(id);
      if (p) { p.dur = duration; p.state = "playing"; }
      this.emit("changed", keyOf(id));
      this.emit("position", keyOf(id), trackOf(id), true, 0, duration);
    });
    engine.on("state", (id, state, pos, dur, looping, exiting) => {
      const p = playbacks.get(id);
      if (!p) return;
      p.state = state; p.pos = pos; p.dur = dur; p.looping = looping; p.exiting = exiting;
      this.emit("position", keyOf(id), trackOf(id), state === "playing", pos, dur);
    });
    engine.on("ended", (id, reason, message) => {
      playbacks.delete(id);
      this.emit("changed", keyOf(id));
      this.emit("position", keyOf(id), trackOf(id), false, 0, 0);
      if (reason === "error") this.#log(`Playback ${id}: ${message}`);
    });
    engine.on("preloaded", (file) => this.#markWarm(`file:${file}`));
    engine.on("reset", () => {
      const ids = new Set([...playbacks.keys()].map(keyOf));
      playbacks.clear();
      ids.forEach((id) => this.emit("changed", id));
      this.#everWarmed.clear();
      this.#requested.clear();
      setTimeout(() => this.prewarmAll(), 2000);
    });
  }

  /** Same behavior as pressing a Stream Deck "Play Sound" key: restart, or (per the sound's `mode`) stop/pause
   * the already-running tracks instead. */
  press(soundId: string): void {
    const s = this.#store.sound(soundId);
    const current = tracksOf(soundId);
    if (current.length > 0 && s.mode !== "restart") {
      if (s.mode === "pause") {
        const ids = current.map((p) => p.id);
        current.some((p) => p.state === "playing") ? this.#engine.pauseMany(ids) : this.#engine.resumeMany(ids);
      } else {
        for (const p of current) this.#engine.stopPlayback(p.id, seconds(p.settings.fadeOut));
      }
      return;
    }
    this.start(soundId, s);
  }

  start(soundId: string, s: PlaySettings): boolean {
    const tracks = Array.from({ length: MAX_TRACKS }, (_, i) => i + 1)
      .map((n) => ({ n, t: trackSettings(s, n) }))
      .map(({ n, t }) => ({ n, t, file: resolvePath(t.file as string | undefined) }))
      .filter(({ t }) => t.file);
    if (tracks.length === 0) {
      this.#log(`Sound "${soundId}": no file found (check the path in the web editor)`);
      return false;
    }
    if (s.stopOthers) {
      const group = s.group;
      for (const p of playbacks.values())
        if (keyOf(p.id) !== soundId && inGroup(p, group)) this.#engine.stopPlayback(p.id, seconds(p.settings.fadeOut));
    }
    const commands: PlayCommand[] = [];
    for (const { n, t, file } of tracks) {
      if (!file) continue;
      const outputs = trackOutputs(t);
      outputs.forEach((out, k) => {
        const id = k === 0 ? `${soundId}#${n}` : `${soundId}#${n}.${k}`;
        commands.push({
          id, file, device: out.device, channel: out.channel, mono: out.mono,
          volume: gainFor(t), loop: !!t.loop,
          fadeIn: seconds(t.fadeIn as number), fadeOut: seconds(t.fadeOut as number),
          trimIn: seconds(t.trimIn as string), trimOut: seconds(t.trimOut as string),
          loopIn: seconds(t.loopIn as string), loopOut: seconds(t.loopOut as string),
          loopFade: seconds(t.loopFade as string),
        });
        playbacks.set(id, { id, settings: t, state: "playing", pos: 0, dur: 0, looping: !!t.loop, exiting: false });
      });
    }
    this.#log(`Playback ${soundId}: ${tracks.length} track(s), ${commands.length} output(s)`);
    this.#engine.playBatch(commands);
    this.emit("changed", soundId);
    return true;
  }

  stop(soundId: string, fade = 0): void {
    for (const p of tracksOf(soundId)) this.#engine.stopPlayback(p.id, fade);
  }

  stopGroup(group: string, fade = 0): void {
    for (const p of playbacks.values()) if (inGroup(p, group)) this.#engine.stopPlayback(p.id, fade);
  }

  stopAll(fade = 0): void {
    this.#engine.stopAll(fade);
  }

  /** Toggles between pause and resume for a sound's currently running tracks. No-op if it isn't playing. */
  pauseResume(soundId: string): void {
    const current = tracksOf(soundId);
    if (current.length === 0) return;
    const ids = current.map((p) => p.id);
    current.some((p) => p.state === "playing") ? this.#engine.pauseMany(ids) : this.#engine.resumeMany(ids);
  }

  exitLoop(soundId: string): void {
    const ids = tracksOf(soundId).map((p) => p.id);
    if (ids.length) this.#engine.exitLoopMany(ids);
  }

  exitLoopGroup(group: string): void {
    const ids = [...playbacks.values()].filter((p) => inGroup(p, group)).map((p) => p.id);
    if (ids.length) this.#engine.exitLoopMany(ids);
  }

  skip(soundId: string, deltaSeconds: number): void {
    const ids = tracksOf(soundId).map((p) => p.id);
    if (ids.length) this.#engine.seekMany(ids, deltaSeconds);
  }

  skipGroup(group: string, deltaSeconds: number): void {
    const ids = [...playbacks.values()].filter((p) => inGroup(p, group)).map((p) => p.id);
    if (ids.length) this.#engine.seekMany(ids, deltaSeconds);
  }

  isPlaying(soundId: string): boolean {
    return tracksOf(soundId).length > 0;
  }

  isActuallyPlaying(soundId: string): boolean {
    return tracksOf(soundId).some((p) => p.state === "playing");
  }

  /** Re-applies the effective volume (sound × group × master) to every running playback of a sound, or all of
   * them (used after a settings edit, and whenever the mixer changes). */
  applyGains(soundId?: string): void {
    for (const p of playbacks.values()) {
      if (soundId && keyOf(p.id) !== soundId) continue;
      this.#engine.volume(p.id, gainFor(p.settings));
    }
  }

  /** The "file:<path>" tokens a sound's tracks need ready. */
  #tokensOf(s: PlaySettings): Set<string> {
    const tokens = new Set<string>();
    for (let n = 1; n <= MAX_TRACKS; n++) {
      const t = trackSettings(s, n);
      if (!t.file) continue;
      const path = resolvePath(t.file as string);
      if (path) tokens.add(`file:${path}`);
    }
    return tokens;
  }

  #request(tok: string): void {
    const at = this.#requested.get(tok);
    if (at !== undefined && Date.now() - at < 15_000) return;
    this.#requested.set(tok, Date.now());
    this.#engine.preload(tok.slice("file:".length));
  }

  #markWarm(token: string): void {
    this.#everWarmed.add(token);
  }

  /** Warms the OS file cache for every configured sound's files — called once at startup and after an engine
   * restart, so the first press of each button doesn't pay for a cold-disk read. */
  prewarmAll(): void {
    for (const s of Object.values(this.#store.sounds())) {
      for (const tok of this.#tokensOf(s)) if (!this.#everWarmed.has(tok)) this.#request(tok);
    }
  }

  /** Called after a sound's settings are saved (web editor): re-warm any newly-referenced files, and push the
   * new volume/group to any of its tracks already playing. */
  settingsChanged(soundId: string, s: PlaySettings): void {
    mixer.addGroup(s.group);
    for (const tok of this.#tokensOf(s)) if (!this.#everWarmed.has(tok)) this.#request(tok);
    for (const p of tracksOf(soundId)) {
      const n = trackOf(p.id);
      p.settings = { ...p.settings, volume: trackSettings(s, n).volume, group: s.group };
      this.#engine.volume(p.id, gainFor(p.settings));
    }
  }
}
