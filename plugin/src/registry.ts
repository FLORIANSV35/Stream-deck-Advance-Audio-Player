import { engine } from "./engine.js";
import { mixer, toGain } from "./mixer.js";
import type { PlaySettings } from "./settings.js";

export interface Playback {
  id: string;
  settings: PlaySettings;
  state: "playing" | "paused";
  pos: number;
  dur: number;
  /** mirrors settings.loop, reported back by the engine for convenience */
  looping: boolean;
  /** true once exitLoop was requested: still playing, but will not wrap back to loopIn again */
  exiting: boolean;
}

/** Running playbacks, indexed by the id of the action (key) that started them. */
export const playbacks = new Map<string, Playback>();

export const gainFor = (s: PlaySettings): number => toGain(s.volume ?? 100) * mixer.gainFor(s.group);

export const inGroup = (p: Playback, group: string | undefined): boolean =>
  !group || (p.settings.group ?? "") === group;

/** Re-applies the effective volume (key × group × master) to all playbacks. */
export function applyGains(): void {
  for (const p of playbacks.values()) engine.volume(p.id, gainFor(p.settings));
}

mixer.on("change", applyGains);
