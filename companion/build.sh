#!/bin/bash
# Builds the SAAP Audio Companion module (dist/) and bundles the native engine binaries into companion/bin/.
# Reuses whatever ../engine/build.sh (macOS) and `cargo build --release --manifest-path ../engine-rs/Cargo.toml`
# (Windows) already produced for the Stream Deck plugin — this script never forks or rebuilds the engine source
# itself, only copies the resulting binaries. Pass --no-engine to skip (re)building the macOS engine and just
# copy whatever is already at plugin/com.saap.audio.sdPlugin/bin/saap-engine.
set -e
cd "$(dirname "$0")"

if [ "$1" != "--no-engine" ] && [ "$(uname)" = "Darwin" ]; then
  (cd .. && ./engine/build.sh)
fi

mkdir -p bin
if [ -f ../plugin/com.saap.audio.sdPlugin/bin/saap-engine ]; then
  cp ../plugin/com.saap.audio.sdPlugin/bin/saap-engine bin/saap-engine
  chmod +x bin/saap-engine
fi
if [ -f ../engine-rs/target/release/saap-engine.exe ]; then
  cp ../engine-rs/target/release/saap-engine.exe bin/saap-engine.exe
fi
if [ ! -f bin/saap-engine ] && [ ! -f bin/saap-engine.exe ]; then
  echo "warning: no engine binary found for either platform (build one first, see the root README)" >&2
fi

npm ci --silent
npx tsc -p tsconfig.json
npx companion-module-build
echo "OK -> *.tgz (bin/: $(ls bin 2>/dev/null | tr '\n' ' '))"
