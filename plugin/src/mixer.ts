import streamDeck from "@elgato/streamdeck";
import { EventEmitter } from "node:events";

type Level = { pct: number; muted: boolean };

/** Volume curve: 100 % = gain 1, 50 % ≈ -12 dB, finer resolution at low levels; up to 200 % = gain 4 (+12 dB boost). */
export const toGain = (pct: number): number => Math.max(0, Math.min(2, pct / 100)) ** 2;

/** Live levels per target: "*" (master) and one level per group. Persisted between sessions. */
class Mixer extends EventEmitter<{ change: [target: string] }> {
  #levels = new Map<string, Level>();
  #groups = new Set<string>();
  /** The rest of the global settings (other features' preferences): written back untouched with every save. */
  #other: Record<string, unknown> = {};

  async load(): Promise<void> {
    const g = await streamDeck.settings.getGlobalSettings<{ levels?: { [target: string]: Level }; groups?: string[] }>();
    const { levels: _levels, groups: _groups, ...other } = g;
    this.#other = other;
    for (const [k, v] of Object.entries(g.levels ?? {})) this.#levels.set(k, v);
    for (const name of g.groups ?? []) this.#groups.add(name);
  }

  #save(): void {
    void streamDeck.settings.setGlobalSettings({
      ...this.#other,
      levels: Object.fromEntries(this.#levels),
      groups: [...this.#groups],
    });
  }

  /** A preference stored next to the mixer levels in the global settings. */
  pref<T>(key: string, fallback: T): T {
    return (this.#other[key] as T | undefined) ?? fallback;
  }

  setPref(key: string, value: unknown): void {
    this.#other[key] = value;
    this.#save();
  }

  /** Remembers a group name so it can be offered in the menus. */
  addGroup(name: string | undefined): void {
    if (!name || name === "*" || this.#groups.has(name)) return;
    this.#groups.add(name);
    this.#save();
  }

  groups(): string[] {
    return [...new Set([...this.#groups, ...[...this.#levels.keys()].filter((k) => k !== "*")])].sort((a, b) => a.localeCompare(b));
  }

  level(target: string): Level {
    return this.#levels.get(target) ?? { pct: 100, muted: false };
  }

  set(target: string, patch: Partial<Level>): void {
    const cur = this.level(target);
    const next: Level = { pct: patch.pct ?? cur.pct, muted: patch.muted ?? cur.muted };
    next.pct = Math.max(0, Math.min(200, Math.round(next.pct)));
    this.#levels.set(target, next);
    this.#save();
    this.emit("change", target);
  }

  #gain(target: string): number {
    const l = this.level(target);
    return l.muted ? 0 : toGain(l.pct);
  }

  /** Gain applied to a playback belonging to this group (master × group). */
  gainFor(group: string | undefined): number {
    return this.#gain("*") * (group ? this.#gain(group) : 1);
  }
}

export const mixer = new Mixer();
