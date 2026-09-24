import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import { mixer } from "./mixer.js";

const REPO = "FLORIANSV35/Stream-deck-Advance-Audio-Player";
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  page: string;
  /** the .streamDeckPlugin package, only when it lives where we expect it */
  asset?: string;
}

const parts = (v: string): number[] => v.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0).slice(0, 3);

/** True when `a` is a newer version than `b` ("v0.2.2" vs "0.2.1.0"). */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * Looks for a newer release on GitHub and, on request, downloads its package and opens it (Stream Deck then asks to
 * install it, as with any plugin file). The check is one anonymous request to github.com and can be switched off from
 * the settings panel; pre-releases are never offered.
 */
class Updater {
  #latest: UpdateInfo | null = null;
  #pending?: Promise<void>;

  get enabled(): boolean {
    return mixer.pref("checkUpdates", true);
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
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "saap-audio-stream-deck-plugin" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const r = (await res.json()) as { tag_name?: string; html_url?: string; assets?: { name?: string; browser_download_url?: string }[] };
      if (!r.tag_name || !isNewer(r.tag_name, streamDeck.info.plugin.version)) { this.#latest = null; return; }
      const asset = r.assets?.find((a) => a.name?.endsWith(".streamDeckPlugin"))?.browser_download_url;
      this.#latest = {
        version: r.tag_name.replace(/^v/, ""),
        page: r.html_url ?? `https://github.com/${REPO}/releases`,
        asset: asset?.startsWith(DOWNLOAD_PREFIX) ? asset : undefined,
      };
    } catch (e) {
      streamDeck.logger.debug(`Update check failed: ${(e as Error).message}`);
    }
  }

  /** State for the settings panels; waits briefly for a check still in flight. */
  async state(): Promise<{ enabled: boolean; current: string; update: UpdateInfo | null }> {
    if (this.#pending) await Promise.race([this.#pending, new Promise((r) => setTimeout(r, 8000))]);
    return { enabled: this.enabled, current: parts(streamDeck.info.plugin.version).join("."), update: this.enabled ? this.#latest : null };
  }

  setEnabled(value: boolean): void {
    mixer.setPref("checkUpdates", value);
    if (value) void this.check();
    else this.#latest = null;
  }

  async openPage(): Promise<void> {
    if (this.#latest) await streamDeck.system.openUrl(this.#latest.page);
  }

  /** Downloads the package of the available update and opens it. Resolves with an error message, or undefined on success. */
  async install(): Promise<string | undefined> {
    const update = this.#latest;
    if (!update?.asset) return "No package to download — open the release page instead.";
    try {
      const res = await fetch(update.asset, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) return `Download failed (${res.status}).`;
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_PACKAGE_BYTES || data.subarray(0, 2).toString() !== "PK") return "The downloaded file is not a plugin package.";
      const file = join(tmpdir(), `SAAP-Audio-${update.version}.streamDeckPlugin`);
      await writeFile(file, data);
      const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", file]] : ["/usr/bin/open", [file]];
      await new Promise<void>((resolve, reject) => execFile(cmd, args, { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
      return undefined;
    } catch (e) {
      return `Update failed: ${(e as Error).message}`;
    }
  }
}

export const updater = new Updater();
