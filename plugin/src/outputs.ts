import type { OutputDevice } from "./engine.js";
import type { PlaySettings } from "./settings.js";

const MAX_CHANNELS = 64;

export interface ParsedOutput {
  device: string;
  channel: number;
  mono: boolean;
}

/** "uid::pair::2" → device + first channel. The uid may itself contain "::". */
export function parseOutput(value: string | undefined): ParsedOutput {
  const m = /^(.*)::(pair|mono)::(\d+)$/.exec(value ?? "");
  if (!m) return { device: "default", channel: 0, mono: false };
  return { device: m[1], mono: m[2] === "mono", channel: Number(m[3]) };
}

/** Items of the output dropdown (one group per device). */
export function outputItems(devices: OutputDevice[]) {
  const items: object[] = [{ label: "System default output", value: "default::pair::0" }];
  for (const d of devices) {
    const n = Math.min(d.channels, MAX_CHANNELS);
    const children: { label: string; value: string }[] = [];
    for (let c = 0; c + 1 < n; c += 2)
      children.push({ label: `Stereo ${c + 1}-${c + 2}`, value: `${d.uid}::pair::${c}` });
    for (let c = 0; c < n; c++) children.push({ label: `Mono ${c + 1}`, value: `${d.uid}::mono::${c}` });
    items.push({ label: d.name, children });
  }
  return items;
}

/** Destinations of a track: checked outputs (`outputs`), or the legacy format (output + extras). No duplicates; empty = default output. */
export function trackOutputs(t: PlaySettings): ParsedOutput[] {
  const raw: unknown[] = Array.isArray(t.outputs) ? t.outputs : [t.output, t.xout1, t.xout2, t.xout3];
  const values = raw.filter((v): v is string => typeof v === "string" && v !== "" && v !== "none");
  const unique = [...new Set(values)];
  return (unique.length > 0 ? unique : ["default::pair::0"]).map(parseOutput);
}
