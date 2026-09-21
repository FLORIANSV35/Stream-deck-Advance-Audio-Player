#!/bin/bash
# Construit dist/com.saap.audio.streamDeckPlugin : le fichier à double-cliquer pour installer le plugin.
set -e
cd "$(dirname "$0")"
./engine/build.sh
(cd plugin && npm ci --silent && npm run build --silent)
VERSION=$(python3 -c "import json;print(json.load(open('plugin/com.saap.audio.sdPlugin/manifest.json'))['Version'])")
mkdir -p dist
OUT="dist/com.saap.audio.streamDeckPlugin"
rm -f "$OUT"
# un .streamDeckPlugin est un zip contenant le dossier .sdPlugin (sans journaux ni fichiers système)
(cd plugin && zip -r -X -q "../$OUT" com.saap.audio.sdPlugin -x "*/logs/*" "*.DS_Store")
echo "OK -> $OUT (version $VERSION, $(du -h "$OUT" | cut -f1))"
