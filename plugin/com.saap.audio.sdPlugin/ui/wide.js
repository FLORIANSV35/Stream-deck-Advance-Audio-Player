// "Open large editor" button of the settings panel: asks the plugin to open the browser editor for this key.
(() => {
  const btn = document.getElementById("open-wide");
  if (!btn) return;
  btn.addEventListener("click", () => SDPIComponents.streamDeckClient.send("sendToPlugin", { event: "openEditor" }));
})();
