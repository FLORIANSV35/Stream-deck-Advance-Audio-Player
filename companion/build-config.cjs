// Read by @companion-module/tools' companion-module-build (see node_modules/@companion-module/tools/dist/scripts/lib/bundle-util.js).
// esbuild only bundles what main.ts actually imports, so the native engine binaries and the editor's static
// web files — read from disk at runtime, never imported as modules — have to be listed here to end up in the
// packaged module at all.
module.exports = {
  extraFiles: ["bin", "web"],
};
