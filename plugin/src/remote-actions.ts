// The actual effect of each group-based control key (Volume, Skip, Stop all, Exit loop, Set loop point),
// extracted so both the key's own onKeyDown and a network-triggered request (see network-server.ts) run the
// exact same logic instead of two copies drifting apart.

import { engine } from "./engine.js";
import { normGroup } from "./groups.js";
import { mixer } from "./mixer.js";
import { ctxOf, inGroup, playbacks, trackOf } from "./registry.js";
import { playAction } from "./actions/play.js";
import type { ExitLoopSettings, SeekSettings, SetLoopPointSettings, StopAllSettings, VolumeSettings } from "./settings.js";

export function runVolume(s: VolumeSettings): void {
  const target = s.target || "*";
  const step = s.step ?? 5;
  const lvl = mixer.level(target);
  switch (s.mode ?? "up") {
    case "up": mixer.set(target, { pct: lvl.pct + step, muted: false }); break;
    case "down": mixer.set(target, { pct: lvl.pct - step }); break;
    case "mute": mixer.set(target, { muted: !lvl.muted }); break;
    case "set": mixer.set(target, { pct: s.value ?? 100, muted: false }); break;
  }
}

export function runSkip(s: SeekSettings): void {
  // a single command for all playbacks: they skip together and stay in sync
  const group = normGroup(s.group);
  const ids = [...playbacks.values()].filter((p) => p.dur > 0 && inGroup(p, group)).map((p) => p.id);
  if (ids.length > 0) engine.seekMany(ids, (s.direction === "back" ? -1 : 1) * (s.seconds ?? 10));
}

export function runStopAll(s: StopAllSettings): void {
  const group = normGroup(s.group);
  for (const p of playbacks.values()) {
    if (!inGroup(p, group)) continue;
    if (s.mode === "cut") engine.cut(p.id);
    else engine.stopPlayback(p.id, s.fade ?? 1.5);
  }
}

export function runExitLoop(s: ExitLoopSettings): void {
  const group = normGroup(s.group);
  // sending exitLoop to a non-looping track is a harmless no-op, so no need to filter on `looping` here
  const ids = [...playbacks.values()].filter((p) => inGroup(p, group)).map((p) => p.id);
  if (ids.length > 0) engine.exitLoopMany(ids);
}

/** Marks a loop-in or loop-out point live, for every distinct track matching a group. Returns whether anything matched. */
export async function runSetLoopPoint(s: SetLoopPointSettings): Promise<boolean> {
  const which = s.which === "out" ? "out" : "in";
  const group = normGroup(s.group);
  const seen = new Set<string>();
  let matched = false;
  for (const p of playbacks.values()) {
    if (!inGroup(p, group)) continue;
    const ctx = ctxOf(p.id), track = trackOf(p.id);
    const key = `${ctx}#${track}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched = true;
    await playAction?.setLoopPoint(ctx, track, which, p.pos);
  }
  return matched;
}
