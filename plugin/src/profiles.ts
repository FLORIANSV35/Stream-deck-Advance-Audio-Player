import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlaySettings } from "./settings.js";

const PLAY_UUID = "com.saap.audio.play";
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

/** Where Stream Deck keeps its profiles (one folder per profile, one manifest.json per page inside it). */
function profileRoots(): string[] {
  const base =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Elgato", "StreamDeck")
      : join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck");
  return ["ProfilesV2", "ProfilesV3"].map((d) => join(base, d)).filter((d) => existsSync(d));
}

function manifestsUnder(dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const found: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { continue; }
    if (isDir) found.push(...manifestsUnder(path, depth + 1));
    else if (name === "manifest.json") found.push(path);
  }
  return found;
}

/**
 * The settings of every Play key in every profile and page — including ones not currently showing.
 *
 * Stream Deck only tells a plugin about a key (willAppear) while it is on screen, so keys on another page of a
 * deck, or in another profile, are invisible to the SDK until the user navigates to them; their files and
 * outputs would only start getting prepared then. Stream Deck's own profile files on disk list them all. This
 * is undocumented, so every step is defensive: anything unreadable or unexpected is just skipped.
 */
export function allPlayKeySettings(): PlaySettings[] {
  const out: PlaySettings[] = [];
  for (const root of profileRoots()) {
    let profiles: string[];
    try { profiles = readdirSync(root).filter((n) => n.endsWith(".sdProfile")); } catch { continue; }
    for (const profile of profiles) {
      for (const file of manifestsUnder(join(root, profile))) {
        try {
          if (statSync(file).size > MAX_MANIFEST_BYTES) continue;
          const manifest = JSON.parse(readFileSync(file, "utf8")) as { Controllers?: { Actions?: Record<string, { UUID?: string; Settings?: PlaySettings }> | null }[] };
          for (const controller of manifest.Controllers ?? []) {
            for (const action of Object.values(controller.Actions ?? {})) {
              if (action?.UUID === PLAY_UUID && action.Settings) out.push(action.Settings);
            }
          }
        } catch { /* not a page manifest, or unreadable: skip */ }
      }
    }
  }
  return out;
}
