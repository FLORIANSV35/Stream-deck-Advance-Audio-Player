import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PlaySettings } from "./settings.js";

export interface MixerLevel {
  pct: number;
  muted: boolean;
}

interface Data {
  /** every configured sound, by the id the user types into a "Play Sound" action's "Sound" field */
  sounds: Record<string, PlaySettings>;
  mixerLevels: Record<string, MixerLevel>;
  groups: string[];
  /** small standalone preferences (currently just the update-check toggle, see updater.ts) */
  prefs: Record<string, unknown>;
}

/**
 * All of this module instance's own persistent state — every sound's settings, and the master/group mixer levels
 * — in one JSON file. Unlike the Stream Deck plugin (where each key's settings live inside Stream Deck's own
 * per-action storage), a Companion action only has a handful of plain fields, so the actual settings live here
 * instead and an action just references a sound by its id (see settings.ts, actions.ts).
 */
export class Store {
  readonly #path: string;
  #data: Data;
  #saveTimer?: NodeJS.Timeout;

  constructor(path: string) {
    this.#path = path;
    this.#data = this.#load();
  }

  #load(): Data {
    try {
      if (!existsSync(this.#path)) return { sounds: {}, mixerLevels: {}, groups: [], prefs: {} };
      const raw = JSON.parse(readFileSync(this.#path, "utf8"));
      return { sounds: raw.sounds ?? {}, mixerLevels: raw.mixerLevels ?? {}, groups: raw.groups ?? [], prefs: raw.prefs ?? {} };
    } catch {
      return { sounds: {}, mixerLevels: {}, groups: [], prefs: {} };
    }
  }

  #scheduleSave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), 250);
  }

  /** Writes immediately, bypassing the debounce — used when the module is shutting down. */
  flush(): void {
    clearTimeout(this.#saveTimer);
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify(this.#data, null, 2));
    } catch { /* best effort: losing the very last edit on a crash is preferable to blocking playback on disk I/O */ }
  }

  sounds(): Record<string, PlaySettings> {
    return this.#data.sounds;
  }

  sound(id: string): PlaySettings {
    return this.#data.sounds[id] ?? {};
  }

  setSound(id: string, s: PlaySettings): void {
    this.#data.sounds[id] = s;
    this.#scheduleSave();
  }

  deleteSound(id: string): void {
    delete this.#data.sounds[id];
    this.#scheduleSave();
  }

  mixerLevel(target: string): MixerLevel {
    return this.#data.mixerLevels[target] ?? { pct: 100, muted: false };
  }

  setMixerLevel(target: string, level: MixerLevel): void {
    this.#data.mixerLevels[target] = level;
    this.#scheduleSave();
  }

  groups(): string[] {
    return [...this.#data.groups].sort((a, b) => a.localeCompare(b));
  }

  addGroup(name: string): void {
    if (!name || name === "*" || this.#data.groups.includes(name)) return;
    this.#data.groups.push(name);
    this.#scheduleSave();
  }

  pref<T>(key: string, fallback: T): T {
    return (this.#data.prefs[key] as T | undefined) ?? fallback;
  }

  setPref(key: string, value: unknown): void {
    this.#data.prefs[key] = value;
    this.#scheduleSave();
  }
}
