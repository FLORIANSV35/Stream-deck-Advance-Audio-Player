import type { Engine } from "./engine.js";
import { mixer } from "./mixer.js";
import { toGain } from "./gain.js";
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

/** Running playbacks, indexed by the id of the sound (and track) that started them. */
export const playbacks = new Map<string, Playback>();

/** A track's playbacks are id'd "<soundId>#<n>" (one per output, suffixed ".<k>" for extra outputs). */
export const keyOf = (id: string): string => id.split("#")[0];
export const trackOf = (id: string): number => parseInt(id.split("#")[1], 10);

export const gainFor = (s: PlaySettings): number => toGain(Number(s.volume ?? 100)) * mixer.gainFor(s.group);

export const inGroup = (p: Playback, group: string | undefined): boolean =>
  !group || (p.settings.group ?? "") === group;

/** Re-applies the effective volume (sound × group × master) to all playbacks. */
export function applyGains(engine: Engine): void {
  for (const p of playbacks.values()) engine.volume(p.id, gainFor(p.settings));
}
