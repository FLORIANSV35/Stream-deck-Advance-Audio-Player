# SAAP Audio — Bitfocus Companion module

Plays the same multi-track synchronized sounds as the [SAAP Audio Stream Deck plugin](../plugin), embedded
directly in [Bitfocus Companion](https://bitfocus.io/companion) — no Stream Deck required. See
[`companion/HELP.md`](companion/HELP.md) for how it's used day to day.

## Why this exists

Companion actions only offer plain fields (text, number, checkbox, dropdown) — there's no way to draw a waveform
or open a native file dialog from inside one. So this module embeds the same native audio engine as the plugin
(`../engine` on macOS, `../engine-rs` on Windows) and serves its own local web page (`web/`) for the actual sound
settings — files, tracks, trim/loop points, output routing, groups — while a Companion action just references a
sound by the id given to it on that page.

## Building

```sh
npm install
./build.sh            # also (re)builds the macOS engine via ../engine/build.sh
./build.sh --no-engine # reuses whatever's already at ../plugin/com.saap.audio.sdPlugin/bin/saap-engine
```

This produces `saap-audio-<version>.tgz` — a complete, installable Companion module (native binaries and the web
editor's files included; see `build-config.cjs`). The Windows binary is only bundled if
`../engine-rs/target/release/saap-engine.exe` already exists (built via
`cargo build --release --manifest-path ../engine-rs/Cargo.toml`) — this script does not cross-compile it.

`npx tsc -p tsconfig.json` alone (no packaging) is enough while iterating — Companion can load `companion/` as an
unpackaged dev module directly (see below).

## Local dev / testing in a real Companion

1. `npm install && npx tsc -p tsconfig.json` (or `./build.sh`, which also copies the native binary in).
2. In Companion: Settings → set the "Developer modules path" to the **parent** folder of this repo (not this
   folder itself — Companion scans its subfolders for a `companion/manifest.json`, and
   `companion/companion/manifest.json` satisfies that from here).
3. Add a "SAAP Audio" connection. Its status line shows the web editor's URL once it starts.
4. Edit source under `src/` or `web/`, re-run `npx tsc -p tsconfig.json` (only needed for `src/` changes — `web/`
   files are read straight off disk on every request) — Companion hot-reloads a dev module when its files change.

## Layout

- `src/` — the module itself (TypeScript, compiled to `dist/`): `main.ts` (the `InstanceBase` entrypoint),
  `engine.ts` (spawns the native binary, same JSON-line protocol as `plugin/src/engine.ts`), `player.ts`
  (turns a sound's settings into engine commands — the Companion equivalent of `plugin/src/actions/play.ts`),
  `editor-server.ts` (the local HTTP+WS server behind the web editor), `store.ts` (this module's own on-disk
  settings, since a Companion action can't hold the rich per-track settings the plugin keeps in Stream Deck's own
  storage), `mixer.ts`/`gain.ts`/`outputs.ts`/`settings.ts`/`registry.ts`/`filepicker.ts` (ported near-verbatim
  from the plugin's own equivalents).
- `web/` — the editor's static files (plain HTML/CSS/JS, no build step): `index.html`, `app.js`, `app.css`,
  `waveform.js` (the same zoom/trim/loop/cursor canvas logic as the plugin's own `waveform.js`, adapted to plain
  `fetch`/WebSocket calls instead of Stream Deck's `sdpi-components`).
- `companion/manifest.json`, `companion/HELP.md` — Companion's own required module metadata.
- `bin/` — gitignored; the native engine binaries, copied in by `build.sh`.
