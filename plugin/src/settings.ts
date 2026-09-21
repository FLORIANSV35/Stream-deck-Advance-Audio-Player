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
  /** points de découpe en secondes (chaîne saisie dans l'inspecteur) */
  trimIn?: string | number;
  trimOut?: string | number;
  /** comportement d'un appui pendant la lecture */
  mode?: "stop" | "pause" | "restart";
  group?: string;
  stopOthers?: boolean;
  /** true = temps restant, false = temps écoulé */
  countdown?: boolean;
  /** pistes 2 à 6 : reprennent le réglage correspondant de la piste 1 (maître) */
  linkCut?: boolean;
  linkFades?: boolean;
  linkVolume?: boolean;
  /** saisie d'un nouveau groupe dans l'inspecteur : devient `group` puis est vidé */
  newGroup?: string;
  /** pistes 2 à 6 : mêmes champs que la piste 1 avec le numéro en suffixe (file2, output2, volume2…) */
  [key: string]: string | number | boolean | string[] | undefined;
};

export const MAX_TRACKS = 6;
/** `outputs` : sorties cochées de la piste (tableau). `output` / `xout1..3` : ancien format, encore lu s'il n'y a pas de `outputs`. */
const TRACK_FIELDS = ["file", "output", "outputs", "xout1", "xout2", "xout3", "volume", "fadeIn", "fadeOut", "trimIn", "trimOut", "loop"] as const;

/** Champs qu'une piste esclave prend à la piste 1 quand la liaison est active. */
const LINKS: [flag: "linkCut" | "linkFades" | "linkVolume", fields: string[]][] = [
  ["linkCut", ["trimIn", "trimOut"]],
  ["linkFades", ["fadeIn", "fadeOut"]],
  ["linkVolume", ["volume"]],
];

/** Réglages effectifs de la piste n (1 = champs sans suffixe), fusionnés avec les réglages communs de la touche. */
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
  /** "*" = général, sinon nom de groupe */
  target?: string;
  step?: number;
  mode?: "up" | "down" | "mute" | "set";
  value?: number;
};

export type StopAllSettings = {
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
  /** saut d'un appui de touche (s) */
  seconds?: number;
  /** saut par cran de cadran (s) */
  dialStep?: number;
};
