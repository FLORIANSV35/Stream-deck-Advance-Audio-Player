import { EventEmitter } from "node:events";
import { toGain } from "./gain.js";
import type { Store } from "./store.js";

/** Live master/group levels, persisted via the shared Store (see store.ts). `attach()` is called once from
 * main.ts's init(), before any action can fire, mirroring the Stream Deck plugin's own `await mixer.load()`. */
class Mixer extends EventEmitter<{ change: [target: string] }> {
  #store?: Store;

  attach(store: Store): void {
    this.#store = store;
  }

  /** Remembers a group name so it can be offered in the mixer/group pickers. */
  addGroup(name: string | undefined): void {
    if (!name || name === "*") return;
    this.#store?.addGroup(name);
  }

  groups(): string[] {
    return this.#store?.groups() ?? [];
  }

  level(target: string): { pct: number; muted: boolean } {
    return this.#store?.mixerLevel(target) ?? { pct: 100, muted: false };
  }

  set(target: string, patch: Partial<{ pct: number; muted: boolean }>): void {
    const cur = this.level(target);
    const next = { pct: patch.pct ?? cur.pct, muted: patch.muted ?? cur.muted };
    next.pct = Math.max(0, Math.min(100, Math.round(next.pct)));
    this.#store?.setMixerLevel(target, next);
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
