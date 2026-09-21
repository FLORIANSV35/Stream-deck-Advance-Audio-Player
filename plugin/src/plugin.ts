import streamDeck from "@elgato/streamdeck";
import { PlayAction } from "./actions/play.js";
import { SeekAction } from "./actions/seek.js";
import { StopAllAction } from "./actions/stop-all.js";
import { VolumeAction } from "./actions/volume.js";
import { engine } from "./engine.js";
import { mixer } from "./mixer.js";

streamDeck.logger.setLevel("info");

engine.start();
process.on("exit", () => engine.stop());

streamDeck.actions.registerAction(new PlayAction());
streamDeck.actions.registerAction(new VolumeAction());
streamDeck.actions.registerAction(new SeekAction());
streamDeck.actions.registerAction(new StopAllAction());

await streamDeck.connect();
// les réglages globaux ne sont lisibles qu'une fois connecté
await mixer.load();
