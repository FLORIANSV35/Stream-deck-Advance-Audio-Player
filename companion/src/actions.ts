import type { CompanionActionDefinitions, CompanionActionInfo } from "@companion-module/base";
import { lastSoundIdFor, rememberSoundId } from "./control-sound.js";
import type { EditorServer } from "./editor-server.js";
import { mixer } from "./mixer.js";
import type { Player } from "./player.js";
import { keyOf, playbacks, trackOf } from "./registry.js";
import type { Store } from "./store.js";

const soundIdField = {
  id: "soundId",
  type: "textinput" as const,
  label: "Sound",
  default: "",
  tooltip: "The sound's id, as named on the web editor's sidebar — see the module's status for the editor's URL. " +
    "Once set here, use \"Learn\" on a feedback (or another action) on the same button to copy it there too.",
};

/** Shared by every action that takes a Sound id: remembers it against this button (see control-sound.ts) so a
 * feedback — or another action — on the same button can "Learn" it instead of the user retyping it. */
const soundIdSubscribe = (action: CompanionActionInfo) => rememberSoundId(action.controlId, String(action.options.soundId ?? "").trim());
const soundIdLearn = (action: CompanionActionInfo) => {
  const soundId = lastSoundIdFor(action.controlId);
  return soundId ? { ...action.options, soundId } : undefined;
};

const groupField = {
  id: "group",
  type: "textinput" as const,
  label: "Group (blank = all sounds)",
  default: "",
  tooltip: "Only affects sounds whose own \"Group\" (set in the web editor) matches. Leave blank for every sound.",
};

/** Everything a Companion button can do, mirroring the Stream Deck plugin's own action set (plugin/src/actions):
 * Play Sound, Stop, Pause/Resume, Stop All, Skip, Exit Loop, Set Loop Point, Set Volume. Every action beyond
 * "Play Sound" is scoped either to one sound (by the id the web editor gave it) or to a group of sounds, exactly
 * like the plugin's own group-scoped control keys. */
export function getActionDefinitions(player: Player, store: Store, editor: EditorServer): CompanionActionDefinitions {
  return {
    "open-editor": {
      name: "Open Sound Editor",
      options: [],
      callback: async () => editor.open(),
    },
    "play-sound": {
      name: "Play Sound",
      options: [soundIdField],
      subscribe: soundIdSubscribe,
      learn: soundIdLearn,
      callback: async (action) => {
        const soundId = String(action.options.soundId ?? "").trim();
        if (soundId) player.press(soundId);
      },
    },
    stop: {
      name: "Stop",
      options: [
        { ...soundIdField, tooltip: "Leave blank to stop every sound instead. " + soundIdField.tooltip },
        { id: "fade", type: "number", label: "Fade out (s)", default: 0, min: 0, max: 30, step: 0.1 },
      ],
      subscribe: soundIdSubscribe,
      learn: soundIdLearn,
      callback: async (action) => {
        const soundId = String(action.options.soundId ?? "").trim();
        const fade = Number(action.options.fade ?? 0);
        if (soundId) player.stop(soundId, fade);
        else player.stopAll(fade);
      },
    },
    "pause-resume": {
      name: "Pause / Resume",
      options: [soundIdField],
      subscribe: soundIdSubscribe,
      learn: soundIdLearn,
      callback: async (action) => {
        const soundId = String(action.options.soundId ?? "").trim();
        if (soundId) player.pauseResume(soundId);
      },
    },
    "exit-loop": {
      name: "Exit Loop",
      options: [groupField],
      callback: async (action) => player.exitLoopGroup(String(action.options.group ?? "")),
    },
    skip: {
      name: "Skip forward / back",
      options: [
        groupField,
        {
          id: "direction", type: "dropdown", label: "Direction", default: "forward",
          choices: [{ id: "forward", label: "Forward" }, { id: "back", label: "Back" }],
        },
        { id: "seconds", type: "number", label: "Seconds", default: 10, min: 0.1, max: 3600, step: 0.5 },
      ],
      callback: async (action) => {
        const seconds = Number(action.options.seconds ?? 10);
        const delta = action.options.direction === "back" ? -seconds : seconds;
        player.skipGroup(String(action.options.group ?? ""), delta);
      },
    },
    "stop-all": {
      name: "Stop All",
      options: [
        groupField,
        {
          id: "mode", type: "dropdown", label: "Mode", default: "fade",
          choices: [{ id: "fade", label: "Fade out" }, { id: "cut", label: "Cut immediately" }],
        },
        {
          id: "fade", type: "number", label: "Fade out (s)", default: 1, min: 0, max: 30, step: 0.1,
          isVisibleExpression: '$(options:mode) == "fade"',
        },
      ],
      callback: async (action) => {
        const group = String(action.options.group ?? "");
        if (action.options.mode === "cut") {
          if (group) player.exitLoopGroup(group); // best-effort: engine has no group-scoped cut, stop what we track instead
          for (const p of [...playbacks.values()]) if (!group || (p.settings.group ?? "") === group) player.stop(keyOf(p.id), 0);
          if (!group) player.stopAll(0);
        } else if (group) {
          player.stopGroup(group, Number(action.options.fade ?? 1));
        } else {
          player.stopAll(Number(action.options.fade ?? 1));
        }
      },
    },
    "set-loop-point": {
      name: "Set Loop Point",
      options: [
        soundIdField,
        {
          id: "which", type: "dropdown", label: "Which point", default: "in",
          choices: [{ id: "in", label: "Loop in" }, { id: "out", label: "Loop out" }],
        },
      ],
      subscribe: soundIdSubscribe,
      learn: soundIdLearn,
      callback: async (action) => {
        const soundId = String(action.options.soundId ?? "").trim();
        if (!soundId) return;
        const track1 = [...playbacks.values()].find((p) => keyOf(p.id) === soundId && trackOf(p.id) === 1);
        if (!track1) return;
        const s = store.sound(soundId);
        const field = action.options.which === "out" ? "loopOut" : "loopIn";
        const updated = { ...s, [field]: track1.pos.toFixed(2), loop: true };
        store.setSound(soundId, updated);
        player.settingsChanged(soundId, updated);
      },
    },
    "set-volume": {
      name: "Set Volume (master / group)",
      options: [
        { id: "target", type: "textinput", label: "Target (\"*\" = master)", default: "*" },
        {
          id: "mode", type: "dropdown", label: "Mode", default: "set",
          choices: [
            { id: "set", label: "Set to…" },
            { id: "up", label: "Increase by…" },
            { id: "down", label: "Decrease by…" },
            { id: "mute", label: "Toggle mute" },
          ],
        },
        {
          id: "value", type: "number", label: "Value (%)", default: 100, min: 0, max: 100, step: 1,
          isVisibleExpression: '$(options:mode) == "set"',
        },
        {
          id: "step", type: "number", label: "Step (%)", default: 10, min: 1, max: 100, step: 1,
          isVisibleExpression: '$(options:mode) == "up" || $(options:mode) == "down"',
        },
      ],
      callback: async (action) => {
        const target = String(action.options.target ?? "*") || "*";
        const cur = mixer.level(target);
        switch (action.options.mode) {
          case "set": mixer.set(target, { pct: Number(action.options.value ?? 100) }); break;
          case "up": mixer.set(target, { pct: cur.pct + Number(action.options.step ?? 10) }); break;
          case "down": mixer.set(target, { pct: cur.pct - Number(action.options.step ?? 10) }); break;
          case "mute": mixer.set(target, { muted: !cur.muted }); break;
        }
      },
    },
  };
}
