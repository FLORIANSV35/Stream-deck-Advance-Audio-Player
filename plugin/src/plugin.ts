import streamDeck from "@elgato/streamdeck";
import { ExitLoopAction } from "./actions/exit-loop.js";
import { PlayAction, playAction } from "./actions/play.js";
import { RemoteTriggerAction } from "./actions/remote-trigger.js";
import { SeekAction } from "./actions/seek.js";
import { SetLoopPointAction } from "./actions/set-loop-point.js";
import { StopAllAction } from "./actions/stop-all.js";
import { VolumeAction } from "./actions/volume.js";
import { engine } from "./engine.js";
import { mixer } from "./mixer.js";
import { networkControl } from "./network-server.js";
import { updater } from "./updater.js";

streamDeck.logger.setLevel("info");

engine.start();
process.on("exit", () => engine.stop());

streamDeck.actions.registerAction(new PlayAction());
streamDeck.actions.registerAction(new VolumeAction());
streamDeck.actions.registerAction(new SeekAction());
streamDeck.actions.registerAction(new SetLoopPointAction());
streamDeck.actions.registerAction(new ExitLoopAction());
streamDeck.actions.registerAction(new StopAllAction());
streamDeck.actions.registerAction(new RemoteTriggerAction());

await streamDeck.connect();
// global settings can only be read once connected
await mixer.load();
updater.start();
networkControl.start();
// every Play key on every page, not only the ones currently showing
playAction?.prewarmAllProfiles();
