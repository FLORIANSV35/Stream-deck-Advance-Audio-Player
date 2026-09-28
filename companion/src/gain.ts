/** Volume curve: 100 % = gain 1, 50 % ≈ -12 dB, finer resolution at low levels. A track's own volume can go up
 * to 200 % (gain 4, +12 dB boost); master/group levels stay capped at 100 %. Same formula as the Stream Deck
 * plugin (plugin/src/mixer.ts) — the native engine only understands a raw linear gain, not a percent. */
export const toGain = (pct: number): number => Math.max(0, Math.min(2, pct / 100)) ** 2;
