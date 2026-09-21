import { engine } from "./engine.js";
import { mixer, toGain } from "./mixer.js";
import type { PlaySettings } from "./settings.js";

export interface Playback {
  id: string;
  settings: PlaySettings;
  state: "playing" | "paused";
  pos: number;
  dur: number;
}

/** Lectures en cours, indexées par l'identifiant de l'action (touche) qui les a lancées. */
export const playbacks = new Map<string, Playback>();

export const gainFor = (s: PlaySettings): number => toGain(s.volume ?? 100) * mixer.gainFor(s.group);

export const inGroup = (p: Playback, group: string | undefined): boolean =>
  !group || (p.settings.group ?? "") === group;

/** Ré-applique le volume effectif (touche × groupe × général) à toutes les lectures. */
export function applyGains(): void {
  for (const p of playbacks.values()) engine.volume(p.id, gainFor(p.settings));
}

mixer.on("change", applyGains);
