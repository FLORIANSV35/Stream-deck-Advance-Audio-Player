import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { mixer } from "./mixer.js";

/** Special menu values: "none" (no group) and "*" (all / master) both mean "no group". */
export const normGroup = (g: unknown): string => (typeof g !== "string" || g === "none" || g === "*" ? "" : g);

/** Group dropdowns of the inspector: each action has its own first entry. */
const FIRST_ENTRY: Record<string, { label: string; value: string }> = {
  getGroupsPlay: { label: "— No group —", value: "none" },
  getGroupsVolume: { label: "Master (all sounds)", value: "*" },
  getGroupsStop: { label: "All sounds", value: "*" },
};

export const isGroupsEvent = (event: unknown): event is string => typeof event === "string" && event in FIRST_ENTRY;

/**
 * Answers the inspector panel that just sent a message. The SDK silently drops a payload while it has not yet seen
 * the panel "appear" — and on a cold start (first time a panel opens, notably on Windows) a page's first requests
 * arrive before that event, so the answers were lost and the panel stayed on "Analyzing file…" / "Looking for
 * interfaces…". Hold the answer until the panel is registered.
 */
export async function replyToInspector(payload: object): Promise<void> {
  for (let i = 0; i < 50 && !streamDeck.ui.action; i++) await new Promise((r) => setTimeout(r, 100));
  await streamDeck.ui.sendToPropertyInspector(payload as JsonValue);
}

/** Sends the group list to the inspector page that asked (Stream Deck's panel by default). */
export async function sendGroups(event: string, reply: (payload: object) => void | Promise<void> = replyToInspector): Promise<void> {
  const items = [FIRST_ENTRY[event], ...mixer.groups().map((g) => ({ label: g, value: g }))];
  await reply({ event, items });
}
