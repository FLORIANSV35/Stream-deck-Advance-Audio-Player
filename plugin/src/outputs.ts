import type { OutputDevice } from "./engine.js";
import type { PlaySettings } from "./settings.js";

const MAX_CHANNELS = 64;

export interface ParsedOutput {
  device: string;
  channel: number;
  mono: boolean;
}

/** "uid::pair::2" → périphérique + canal de départ. Le uid peut contenir "::". */
export function parseOutput(value: string | undefined): ParsedOutput {
  const m = /^(.*)::(pair|mono)::(\d+)$/.exec(value ?? "");
  if (!m) return { device: "default", channel: 0, mono: false };
  return { device: m[1], mono: m[2] === "mono", channel: Number(m[3]) };
}

/** Éléments du menu déroulant de sortie (sdpi-select avec groupes par périphérique). */
export function outputItems(devices: OutputDevice[]) {
  const items: object[] = [{ label: "Sortie par défaut du système", value: "default::pair::0" }];
  for (const d of devices) {
    const n = Math.min(d.channels, MAX_CHANNELS);
    const children: { label: string; value: string }[] = [];
    for (let c = 0; c + 1 < n; c += 2)
      children.push({ label: `Stéréo ${c + 1}-${c + 2}`, value: `${d.uid}::pair::${c}` });
    for (let c = 0; c < n; c++) children.push({ label: `Mono ${c + 1}`, value: `${d.uid}::mono::${c}` });
    items.push({ label: d.name, children });
  }
  return items;
}

/** Destinations d'une piste : sorties cochées (`outputs`), ou ancien format (sortie + extras). Sans doublon ; vide = sortie par défaut. */
export function trackOutputs(t: PlaySettings): ParsedOutput[] {
  const raw: unknown[] = Array.isArray(t.outputs) ? t.outputs : [t.output, t.xout1, t.xout2, t.xout3];
  const values = raw.filter((v): v is string => typeof v === "string" && v !== "" && v !== "none");
  const unique = [...new Set(values)];
  return (unique.length > 0 ? unique : ["default::pair::0"]).map(parseOutput);
}
