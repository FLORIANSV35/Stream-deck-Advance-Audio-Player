import streamDeck from "@elgato/streamdeck";
import { EventEmitter } from "node:events";

type Level = { pct: number; muted: boolean };

/** Courbe de volume : 100 % = gain 1, 50 % ≈ -12 dB, plus fin dans les bas niveaux. */
export const toGain = (pct: number): number => Math.max(0, Math.min(1, pct / 100)) ** 2;

/** Niveaux live par cible : "*" (général) et un niveau par groupe. Persistés entre les sessions. */
class Mixer extends EventEmitter<{ change: [target: string] }> {
  #levels = new Map<string, Level>();
  #groups = new Set<string>();

  async load(): Promise<void> {
    const g = await streamDeck.settings.getGlobalSettings<{ levels?: { [target: string]: Level }; groups?: string[] }>();
    for (const [k, v] of Object.entries(g.levels ?? {})) this.#levels.set(k, v);
    for (const name of g.groups ?? []) this.#groups.add(name);
  }

  #save(): void {
    void streamDeck.settings.setGlobalSettings({
      levels: Object.fromEntries(this.#levels),
      groups: [...this.#groups],
    });
  }

  /** Mémorise un nom de groupe pour le proposer dans les menus. */
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
    next.pct = Math.max(0, Math.min(100, Math.round(next.pct)));
    this.#levels.set(target, next);
    this.#save();
    this.emit("change", target);
  }

  #gain(target: string): number {
    const l = this.level(target);
    return l.muted ? 0 : toGain(l.pct);
  }

  /** Gain appliqué à une lecture appartenant à ce groupe (général × groupe). */
  gainFor(group: string | undefined): number {
    return this.#gain("*") * (group ? this.#gain(group) : 1);
  }
}

export const mixer = new Mixer();
