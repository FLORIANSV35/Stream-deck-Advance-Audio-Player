// Remote Trigger settings panel: shows only the fields for the selected kind, and "Test connection" fetches
// the host's Play keys / groups so a target can be picked instead of typed.
(() => {
  const { streamDeckClient: sd, useSettings } = SDPIComponents;

  function watch(settingName, onChange) {
    document.querySelectorAll(`[setting="${CSS.escape(settingName)}"]`).forEach((el) => {
      el.addEventListener("valuechange", () => onChange(el.value));
    });
  }

  // show only the section(s) matching the selected kind
  let kind = "play";
  function applyKind() {
    document.querySelectorAll("[data-kind]").forEach((el) => {
      el.style.display = el.dataset.kind === kind ? "" : "none";
    });
  }
  const [getKind] = useSettings("kind", (v) => { kind = v || "play"; applyKind(); }, 0);
  getKind().then((v) => { kind = v || "play"; applyKind(); });
  watch("kind", (v) => { kind = v || "play"; applyKind(); });

  // "Play a key": a plain <select> populated after Test connection, kept in sync with the real (hidden)
  // targetCtx/targetLabel settings so the choice survives a reopen of the panel
  const targetSelect = document.getElementById("target-key");
  let targetCtx = "";
  const [getTargetCtx, setTargetCtx] = useSettings("targetCtx", (v) => { targetCtx = v || ""; syncTargetSelect(); }, 0);
  const [, setTargetLabel] = useSettings("targetLabel", null, 0);
  getTargetCtx().then((v) => { targetCtx = v || ""; syncTargetSelect(); });
  function syncTargetSelect() {
    if ([...targetSelect.options].some((o) => o.value === targetCtx)) targetSelect.value = targetCtx;
  }
  targetSelect?.addEventListener("change", () => {
    setTargetCtx(targetSelect.value);
    setTargetLabel(targetSelect.selectedOptions[0]?.textContent ?? "");
  });

  // "Test connection": asks the plugin to reach the host with the currently-typed fields (not yet saved)
  const btn = document.getElementById("test-connection");
  const status = document.getElementById("test-status");
  const field = (name) => document.querySelector(`[setting="${name}"]`)?.value;
  btn?.addEventListener("click", () => {
    status.textContent = "Testing…";
    status.className = "teststatus";
    sd.send("sendToPlugin", {
      event: "testConnection", host: field("host"), port: Number(field("port")) || 0, key: field("key"),
    });
  });
  sd.sendToPropertyInspector.subscribe((ev) => {
    const p = ev.payload;
    if (!p || p.event !== "testResult") return;
    if (p.ok) {
      status.textContent = `Connected — found ${p.keys.length} key(s), ${p.groups.length} group(s): ${p.groups.join(", ") || "none"}`;
      status.className = "teststatus ok";
      const current = targetSelect.value;
      targetSelect.innerHTML = p.keys
        .map((k) => `<option value="${k.ctx}">${k.label}${k.group ? ` (${k.group})` : ""}</option>`)
        .join("") || '<option value="">No Play key showing on the host</option>';
      targetSelect.value = current || targetCtx;
      syncTargetSelect();
    } else {
      status.textContent = p.error || "Connection failed";
      status.className = "teststatus err";
    }
  });
})();
