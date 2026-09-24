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

/** Sends the group list to the inspector page that asked (Stream Deck's panel by default). */
export async function sendGroups(event: string, reply?: (payload: object) => void | Promise<void>): Promise<void> {
  const items = [FIRST_ENTRY[event], ...mixer.groups().map((g) => ({ label: g, value: g }))];
  if (reply) await reply({ event, items });
  else await streamDeck.ui.sendToPropertyInspector({ event, items } as JsonValue);
}
