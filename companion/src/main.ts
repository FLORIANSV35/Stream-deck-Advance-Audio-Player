import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceBase, InstanceStatus, runEntrypoint } from "@companion-module/base";
import { getActionDefinitions } from "./actions.js";
import { type SaapConfig, getConfigFields } from "./config.js";
import { EditorServer } from "./editor-server.js";
import { Engine } from "./engine.js";
import { getFeedbackDefinitions } from "./feedbacks.js";
import { mixer } from "./mixer.js";
import { Player } from "./player.js";
import { getPresetDefinitions } from "./presets.js";
import { Store } from "./store.js";
import { Updater } from "./updater.js";

/**
 * Where bin/ (the bundled native engine) and web/ (the editor's static files) live. Companion sets a spawned
 * module's cwd to that module's own install directory (confirmed via `lsof -p <pid>` against a real running
 * instance), which is the one reliable source here — `import.meta.url` looks like the obvious choice, but
 * webpack (companion-module-build's bundler for this API version) resolves it at *build* time and bakes in the
 * literal absolute path main.ts was compiled from, on the machine that ran the build. Once packaged and
 * installed on any other machine (or even the same machine, once Companion extracts its own copy under
 * ~/Library/Application Support/companion/modules/), that path no longer exists — every subsequent readFile()
 * against it fails, and the editor's whole page 404s. import.meta.url is kept only as a fallback for `tsc`+`node
 * dist/main.js` run directly during development with an unexpected cwd.
 */
function findPackageRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  for (const dir of [process.cwd(), scriptDir, join(scriptDir, "..")]) {
    if (existsSync(join(dir, "bin")) && existsSync(join(dir, "web"))) return dir;
  }
  return process.cwd();
}
const packageRoot = findPackageRoot();

/** Plays multi-track synchronized sounds directly from Companion — see companion/HELP.md for the full picture.
 * Embeds the same native audio engine as the SAAP Audio Stream Deck plugin (companion/src/engine.ts), and serves
 * a local web page for the actual sound settings (companion/src/editor-server.ts), since Companion actions only
 * offer plain fields. */
class SaapAudioInstance extends InstanceBase<SaapConfig> {
  #engine?: Engine;
  #store?: Store;
  #player?: Player;
  #editor?: EditorServer;

  async init(config: SaapConfig): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      this.updateStatus(InstanceStatus.BadConfig, "SAAP Audio only ships an engine for macOS and Windows");
      return;
    }

    const dataDir = config.dataDir?.trim() || join(homedir(), ".saap-audio-companion", this.id);
    const store = new Store(join(dataDir, "data.json"));
    this.#store = store;
    mixer.attach(store);

    const engine = new Engine(packageRoot, (msg) => this.log("debug", msg));
    this.#engine = engine;

    const player = new Player(engine, store, (msg) => this.log("info", msg));
    this.#player = player;
    player.on("changed", () => this.checkFeedbacks("is-playing", "is-paused", "sound-title", "sound-time"));
    // track 1's ~10×/s position ticks (see Player#timeInfo) drive the live countdown on "Sound Title + Time"
    player.on("position", (_soundId, track) => { if (track === 1) this.checkFeedbacks("sound-time"); });
    mixer.on("change", () => player.applyGains());

    const updater = new Updater(store, packageRoot);
    updater.start();

    const editor = new EditorServer(engine, store, player, updater, join(packageRoot, "web"), join(dataDir, "uploads"));
    this.#editor = editor;

    this.setActionDefinitions(getActionDefinitions(player, store, editor));
    this.setFeedbackDefinitions(getFeedbackDefinitions(player, store));
    this.setPresetDefinitions(getPresetDefinitions());

    this.updateStatus(InstanceStatus.Connecting, "Starting the audio engine…");
    engine.start();
    await editor.start();
    this.updateStatus(InstanceStatus.Ok, `Editor: ${editor.url()}`);
    this.log("info", `SAAP Audio editor: ${editor.url()}`);
    setTimeout(() => player.prewarmAll(), 500);
  }

  async configUpdated(_config: SaapConfig): Promise<void> {
    // dataDir changes only take effect on the next restart (Companion restarts an instance when its config
    // changes, which re-runs init() from scratch — nothing to do here).
  }

  getConfigFields() {
    return getConfigFields();
  }

  async destroy(): Promise<void> {
    this.#editor?.close();
    this.#engine?.stop();
    this.#store?.flush();
  }
}

runEntrypoint(SaapAudioInstance, []);
