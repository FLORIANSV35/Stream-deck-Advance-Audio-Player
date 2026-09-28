import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";

const REPO = "FLORIANSV35/Stream-deck-Advance-Audio-Player";
// releases of this module are tagged separately from the Stream Deck plugin's own "vX.Y.Z" tags, since they
// version independently — see the root README/release workflow for the plugin's own tag scheme
const TAG_PREFIX = "companion-v";
const DAY = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  page: string;
}

const parts = (v: string): number[] => v.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0).slice(0, 3);

/** True when `a` is a newer version than `b` ("0.2.0" vs "0.1.3"). */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * Looks for a newer release of this module on GitHub — same idea as the Stream Deck plugin's own updater.ts, but
 * simpler: there's no way for a Companion module to install itself the way a double-clicked .streamDeckPlugin
 * does, so this only ever links to the release page for a manual re-import, and checks releases tagged
 * "companion-v*" specifically (the plugin's own "vX.Y.Z" releases are a separate, unrelated version line). The
 * check is one anonymous request to github.com and can be switched off (see setEnabled).
 */
export class Updater {
  readonly #store: Store;
  readonly #currentVersion: string;
  #latest: UpdateInfo | null = null;
  #pending?: Promise<void>;

  constructor(store: Store, packageRoot: string) {
    this.#store = store;
    this.#currentVersion = Updater.#readVersion(packageRoot);
  }

  static #readVersion(packageRoot: string): string {
    try {
      const manifest = JSON.parse(readFileSync(join(packageRoot, "companion", "manifest.json"), "utf8"));
      return typeof manifest.version === "string" ? manifest.version : "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  get enabled(): boolean {
    return this.#store.pref("checkUpdates", true);
  }

  start(): void {
    void this.check();
    setInterval(() => void this.check(), DAY).unref();
  }

  check(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return (this.#pending ??= this.#fetch().finally(() => { this.#pending = undefined; }));
  }

  async #fetch(): Promise<void> {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "saap-audio-companion-module" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const releases = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }[];
      const match = releases.find((r) => !r.draft && !r.prerelease && r.tag_name?.startsWith(TAG_PREFIX));
      const version = match?.tag_name?.slice(TAG_PREFIX.length);
      if (!version || !isNewer(version, this.#currentVersion)) { this.#latest = null; return; }
      this.#latest = { version, page: match!.html_url ?? `https://github.com/${REPO}/releases` };
    } catch {
      // an unreachable github.com (offline, blocked, rate-limited) just means no update is offered this time
    }
  }

  /** State for the web editor's banner; waits briefly for a check still in flight. */
  async state(): Promise<{ enabled: boolean; current: string; update: UpdateInfo | null }> {
    if (this.#pending) await Promise.race([this.#pending, new Promise((r) => setTimeout(r, 8000))]);
    return { enabled: this.enabled, current: this.#currentVersion, update: this.enabled ? this.#latest : null };
  }

  setEnabled(value: boolean): void {
    this.#store.setPref("checkUpdates", value);
    if (value) void this.check();
    else this.#latest = null;
  }
}
