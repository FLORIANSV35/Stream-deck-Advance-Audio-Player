// "Update available" bar and the update-check preference, shared by the settings panel and the large editor.
(() => {
  const sd = SDPIComponents.streamDeckClient;
  const bar = document.getElementById("updatebar");
  const text = document.getElementById("update-text");
  const install = document.getElementById("update-install");
  const notes = document.getElementById("update-notes");
  const enabled = document.getElementById("update-enabled");
  const current = document.getElementById("update-current");
  if (!bar) return;

  sd.sendToPropertyInspector.subscribe((ev) => {
    const p = ev.payload;
    if (!p) return;
    if (p.event === "update") {
      enabled.checked = p.enabled;
      current.textContent = p.current + (p.enabled ? (p.update ? "" : " — up to date") : "");
      bar.hidden = !p.update;
      if (p.update) {
        text.textContent = `Version ${p.update.version} is available (you have ${p.current}).`;
        install.hidden = !p.update.asset;
        install.disabled = false;
        install.textContent = "Install";
      }
    } else if (p.event === "updateStatus") {
      if (p.state === "downloading") { install.disabled = true; install.textContent = "Downloading…"; }
      else if (p.state === "opened") { text.textContent = "Downloaded — confirm the installation in Stream Deck."; install.hidden = true; }
      else { install.disabled = false; install.textContent = "Retry"; text.textContent = p.message; }
    }
  });
  install.addEventListener("click", () => sd.send("sendToPlugin", { event: "installUpdate" }));
  notes.addEventListener("click", () => sd.send("sendToPlugin", { event: "openUpdatePage" }));
  enabled.addEventListener("change", () => sd.send("sendToPlugin", { event: "setUpdateCheck", value: enabled.checked }));
  sd.send("sendToPlugin", { event: "getUpdate" });
})();
