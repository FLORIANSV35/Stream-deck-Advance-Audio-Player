// "Network control" section of the settings panel: lets this computer accept triggers from another one's
// Remote Trigger key (see network-server.ts). Global, not per-key — same pattern as update.js.
(() => {
  const sd = SDPIComponents.streamDeckClient;
  const enabled = document.getElementById("net-enabled");
  const key = document.getElementById("net-key");
  const port = document.getElementById("net-port");
  const status = document.getElementById("net-status");
  if (!enabled) return;

  let saveTimer;
  const debouncedSend = (event, value) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => sd.send("sendToPlugin", { event, value }), 400);
  };

  sd.sendToPropertyInspector.subscribe((ev) => {
    const p = ev.payload;
    if (!p || p.event !== "network") return;
    enabled.checked = p.enabled;
    if (document.activeElement !== key) key.value = p.hasKey ? key.value || "••••••••" : "";
    if (document.activeElement !== port) port.value = p.port;
    if (!p.enabled) status.textContent = "Off";
    else if (!p.hasKey) status.textContent = "Set a passphrase to start";
    else if (p.listening) status.textContent = `Listening on ${(p.addresses[0] || "this computer")}:${p.port}` + (p.addresses.length > 1 ? ` (also: ${p.addresses.slice(1).join(", ")})` : "");
    else status.textContent = "Could not start — is the port already in use?";
  });

  enabled.addEventListener("change", () => sd.send("sendToPlugin", { event: "setNetworkEnabled", value: enabled.checked }));
  key.addEventListener("focus", () => { if (key.value === "••••••••") key.value = ""; });
  key.addEventListener("input", () => debouncedSend("setNetworkKey", key.value));
  port.addEventListener("input", () => { if (port.value) debouncedSend("setNetworkPort", Number(port.value)); });

  sd.send("sendToPlugin", { event: "getNetwork" });
})();
