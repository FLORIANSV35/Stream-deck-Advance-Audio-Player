#!/bin/bash
# Builds the audio engine (universal arm64 + x86_64) into plugin/com.saap.audio.sdPlugin/bin/saap-engine
set -e
cd "$(dirname "$0")"
OUT="../plugin/com.saap.audio.sdPlugin/bin"
mkdir -p "$OUT" .build
for arch in arm64 x86_64; do
  clang -O2 -fobjc-arc -arch "$arch" -mmacosx-version-min=12.0 \
    -framework AVFoundation -framework CoreAudio -framework AudioToolbox -framework Foundation \
    src/main.m -o ".build/saap-engine-$arch"
done
lipo -create .build/saap-engine-arm64 .build/saap-engine-x86_64 -output "$OUT/saap-engine"
codesign -s - -f "$OUT/saap-engine" 2>/dev/null || true
echo "OK -> $OUT/saap-engine"
