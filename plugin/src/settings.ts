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
  /** crossfade duration (s) on every wrap: the tail past loopOut blends into the head at loopIn */
  loopFade?: string | number;
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
  linkLoop?: boolean;
  /** new group typed in the inspector: becomes `group`, then is cleared */
  newGroup?: string;
  /** tracks 2 to 6: same fields as track 1 with the number as a suffix (file2, output2, volume2…) */
  [key: string]: string | number | boolean | string[] | undefined;
};

export const MAX_TRACKS = 6;
/** `outputs`: checked outputs of the track (array). `output` / `xout1..3`: legacy format, still read when there is no `outputs`. */
const TRACK_FIELDS = [
  "file", "output", "outputs", "xout1", "xout2", "xout3", "volume",
  "fadeIn", "fadeOut", "trimIn", "trimOut", "loop", "loopIn", "loopOut", "loopFade",
] as const;

/** Fields a slave track takes from track 1 when the link is active. */
const LINKS: [flag: "linkCut" | "linkFades" | "linkVolume" | "linkLoop", fields: string[]][] = [
  ["linkCut", ["trimIn", "trimOut"]],
  ["linkFades", ["fadeIn", "fadeOut", "loopFade"]],
  ["linkVolume", ["volume"]],
  ["linkLoop", ["loopIn", "loopOut"]],
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

export type SetLoopPointSettings = {
  /** name shown on the key (lets you have several distinct set-loop-point buttons) */
  label?: string;
  group?: string;
  which?: "in" | "out";
};

/** What a Remote Trigger key sends to another computer's SAAP Audio over the network (see network-server.ts). */
export type RemoteTriggerSettings = {
  label?: string;
  host?: string;
  port?: number;
  key?: string;
  kind?: "play" | "volume" | "skip" | "stopAll" | "exitLoop" | "loopPoint";
  /** kind "play": the id of the target Play key on the host, from the list "Test connection" fetches */
  targetCtx?: string;
  targetLabel?: string;
  /** kind "volume" */
  target?: string;
  mode?: string;
  step?: number;
  value?: number;
  /** kinds "skip" / "stopAll" / "exitLoop" / "loopPoint": group name on the host ("" = all sounds) */
  group?: string;
  direction?: "forward" | "back";
  seconds?: number;
  fade?: number;
  which?: "in" | "out";
};
