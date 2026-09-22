export type PlaySettings = {
  file?: string;
  label?: string;
  /** "uid::pair::0" | "uid::mono::2" | "default::pair::0" */
  output?: string;
  /** 0-100 */
  volume?: number;
  loop?: boolean;
  /** secondes */
  fadeIn?: number;
  fadeOut?: number;
  /** trim points in seconds (string typed in the inspector) */
  trimIn?: string | number;
  trimOut?: string | number;
  /** loop sub-range within the trim, in seconds; unset/0 = loop the whole trim (string typed in the inspector) */
  loopIn?: string | number;
  loopOut?: string | number;
  /** behavior of a key press during playback */
  mode?: "stop" | "pause" | "restart";
  group?: string;
  stopOthers?: boolean;
  /** true = time remaining, false = time elapsed */
  countdown?: boolean;
  /** tracks 2 to 6: take the matching setting from track 1 (master) */
  linkCut?: boolean;
  linkFades?: boolean;
  linkVolume?: boolean;
  /** new group typed in the inspector: becomes `group`, then is cleared */
  newGroup?: string;
  /** tracks 2 to 6: same fields as track 1 with the number as a suffix (file2, output2, volume2…) */
  [key: string]: string | number | boolean | string[] | undefined;
};

export const MAX_TRACKS = 6;
/** `outputs`: checked outputs of the track (array). `output` / `xout1..3`: legacy format, still read when there is no `outputs`. */
const TRACK_FIELDS = [
  "file", "output", "outputs", "xout1", "xout2", "xout3", "volume",
  "fadeIn", "fadeOut", "trimIn", "trimOut", "loop", "loopIn", "loopOut",
] as const;

/** Fields a slave track takes from track 1 when the link is active. */
const LINKS: [flag: "linkCut" | "linkFades" | "linkVolume", fields: string[]][] = [
  ["linkCut", ["trimIn", "trimOut", "loopIn", "loopOut"]],
  ["linkFades", ["fadeIn", "fadeOut"]],
  ["linkVolume", ["volume"]],
];

/** Effective settings of track n (1 = fields without suffix), merged with the key's shared settings. */
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

export type VolumeSettings = {
  /** "*" = master, otherwise a group name */
  target?: string;
  step?: number;
  mode?: "up" | "down" | "mute" | "set";
  value?: number;
};

export type StopAllSettings = {
  /** name shown on the key (lets you have several distinct stop buttons) */
  label?: string;
  group?: string;
  mode?: "fade" | "cut";
  fade?: number;
};

export const seconds = (v: string | number | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat((v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export type SeekSettings = {
  group?: string;
  direction?: "forward" | "back";
  /** skip of one key press (s) */
  seconds?: number;
  /** skip per dial notch (s) */
  dialStep?: number;
};

export type ExitLoopSettings = {
  /** name shown on the key (lets you have several distinct exit-loop buttons) */
  label?: string;
  group?: string;
};
