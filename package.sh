#!/bin/bash
# Construit dist/com.saap.audio.streamDeckPlugin : le fichier à double-cliquer pour installer le plugin.
# Sur macOS il compile le moteur natif ; avec --no-engine (CI) il reprend les binaires déjà présents dans
# plugin/com.saap.audio.sdPlugin/bin (saap-engine pour macOS, saap-engine.exe pour Windows).
set -e
cd "$(dirname "$0")"
[ "$1" = "--no-engine" ] || ./engine/build.sh
(cd plugin && npm ci --silent && npm run build --silent)
VERSION=$(python3 -c "import json;print(json.load(open('plugin/com.saap.audio.sdPlugin/manifest.json'))['Version'])")
mkdir -p dist
OUT="dist/com.saap.audio.streamDeckPlugin"
rm -f "$OUT"
# un .streamDeckPlugin est un zip contenant le dossier .sdPlugin (sans journaux ni fichiers système)
(cd plugin && zip -r -X -q "../$OUT" com.saap.audio.sdPlugin -x "*/logs/*" "*.DS_Store")
echo "OK -> $OUT (version $VERSION, $(du -h "$OUT" | cut -f1))"
