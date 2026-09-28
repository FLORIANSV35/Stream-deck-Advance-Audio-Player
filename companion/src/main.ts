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

/**
 * Where bin/ (the bundled native engine) and web/ (the editor's static files) live, relative to this running
 * script. companion-module-build bundles main.js straight into the package root, so bin/ and web/ end up as its
 * siblings once packaged — but in an unpackaged dev checkout, tsc instead emits to dist/main.js, one level below
 * the actual package root where bin/ and web/ were copied by build.sh. Checking both keeps `npm run dev-build`
 * (no packaging step) and a real packaged install both working without a special-cased dev copy step.
 */
function findPackageRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(scriptDir, "bin")) || existsSync(join(scriptDir, "web")) ? scriptDir : join(scriptDir, "..");
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
    player.on("changed", () => this.checkFeedbacks("is-playing", "is-paused"));
    mixer.on("change", () => player.applyGains());

    const editor = new EditorServer(engine, store, player, join(packageRoot, "web"), join(dataDir, "uploads"));
    this.#editor = editor;

    this.setActionDefinitions(getActionDefinitions(player, store, editor));
    this.setFeedbackDefinitions(getFeedbackDefinitions(player));
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
