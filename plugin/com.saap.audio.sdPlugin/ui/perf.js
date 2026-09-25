// "Performance" section of the settings panel: whether output devices are kept awake (see PlayAction.warmDevices).
(() => {
  const sd = SDPIComponents.streamDeckClient;
  const box = document.getElementById("warm-enabled");
  if (!box) return;
  sd.sendToPropertyInspector.subscribe((ev) => {
    if (ev.payload && ev.payload.event === "warm") box.checked = ev.payload.enabled;
  });
  box.addEventListener("change", () => sd.send("sendToPlugin", { event: "setWarmDevices", value: box.checked }));
  sd.send("sendToPlugin", { event: "getWarm" });
})();
