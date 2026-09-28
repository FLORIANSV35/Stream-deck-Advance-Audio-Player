/** One "sound": up to 6 synchronized tracks, stored under a user-chosen key id (see store.ts). Same shape as the
 * Stream Deck plugin's PlaySettings (plugin/src/settings.ts) so the playback logic (player.ts) matches exactly. */
export type PlaySettings = {
  file?: string;
  label?: string;
  /** "uid::pair::0" | "uid::mono::2" | "default::pair::0" */
  output?: string;
  outputs?: string[];
  /** 0-200 */
  volume?: number;
  loop?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  trimIn?: string | number;
  trimOut?: string | number;
  loopIn?: string | number;
  loopOut?: string | number;
  loopFade?: string | number;
  /** behavior of a "Play Sound" action press while already playing */
  mode?: "stop" | "pause" | "restart";
  group?: string;
  stopOthers?: boolean;
  /** tracks 2 to 6: take the matching setting from track 1 (master) */
  linkCut?: boolean;
  linkFades?: boolean;
  linkVolume?: boolean;
  linkLoop?: boolean;
  /** tracks 2 to 6: same fields as track 1 with the number as a suffix (file2, output2, volume2…) */
  [key: string]: string | number | boolean | string[] | undefined;
};

export const MAX_TRACKS = 6;
const TRACK_FIELDS = [
  "file", "output", "outputs", "volume",
  "fadeIn", "fadeOut", "trimIn", "trimOut", "loop", "loopIn", "loopOut", "loopFade",
] as const;

const LINKS: [flag: "linkCut" | "linkFades" | "linkVolume" | "linkLoop", fields: string[]][] = [
  ["linkCut", ["trimIn", "trimOut"]],
  ["linkFades", ["fadeIn", "fadeOut", "loopFade"]],
  ["linkVolume", ["volume"]],
  ["linkLoop", ["loopIn", "loopOut"]],
];

/** Effective settings of track n (1 = fields without suffix), merged with the sound's shared settings. */
export function trackSettings(s: PlaySettings, n: number): PlaySettings {
  const merged: PlaySettings = { ...s };
  for (const f of TRACK_FIELDS) (merged as Record<string, unknown>)[f] = s[n === 1 ? f : f + n];
  if (n > 1) {
    for (const [flag, fields] of LINKS)
      if (s[flag]) for (const f of fields) (merged as Record<string, unknown>)[f] = s[f];
  }
  merged.group = typeof s.group !== "string" || s.group === "none" || s.group === "*" ? "" : s.group;
  return merged;
}

export const seconds = (v: string | number | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat((v ?? "").toString().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
