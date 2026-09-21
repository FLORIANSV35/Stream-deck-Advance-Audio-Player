#!/bin/bash
# Builds dist/com.saap.audio.streamDeckPlugin: the file to double-click to install the plugin.
# On macOS it compiles the native engine; with --no-engine (CI) it reuses the binaries already present in
# plugin/com.saap.audio.sdPlugin/bin (saap-engine for macOS, saap-engine.exe for Windows).
set -e
cd "$(dirname "$0")"
[ "$1" = "--no-engine" ] || ./engine/build.sh
(cd plugin && npm ci --silent && npm run build --silent)
VERSION=$(python3 -c "import json;print(json.load(open('plugin/com.saap.audio.sdPlugin/manifest.json'))['Version'])")
mkdir -p dist
OUT="dist/com.saap.audio.streamDeckPlugin"
rm -f "$OUT"
# a .streamDeckPlugin is a zip containing the .sdPlugin folder (without logs or system files)
(cd plugin && zip -r -X -q "../$OUT" com.saap.audio.sdPlugin -x "*/logs/*" "*.DS_Store")
echo "OK -> $OUT (version $VERSION, $(du -h "$OUT" | cut -f1))"
