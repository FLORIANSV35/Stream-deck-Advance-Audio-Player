// Large editor page (a browser tab served by the plugin): connects the real inspector page to the plugin over the
// same WebSocket protocol Stream Deck's own panel uses, so every field works exactly as in the app.
(() => {
  const cfg = window.SAAP_EDITOR;
  if (!cfg) return;

  // sdpi-components always dials ws://localhost:<port>, which a browser may resolve to ::1; the plugin listens on 127.0.0.1
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) { super(String(url).replace("//localhost:", "//127.0.0.1:"), protocols); }
  };

  // sdpi-item fixes its columns at 95px + 241px inside its shadow DOM (sized for Stream Deck's narrow panel):
  // give the label a comfortable width and let the field take the rest
  const wide = new CSSStyleSheet();
  wide.replaceSync(".grid{grid-template-columns:150px minmax(0,1fr)}");
  customElements.whenDefined("sdpi-item").then(() => {
    document.querySelectorAll("sdpi-item").forEach((item) => {
      Promise.resolve(item.updateComplete).then(() => {
        item.shadowRoot.adoptedStyleSheets = [...item.shadowRoot.adoptedStyleSheets, wide];
      });
    });
  });

  const banner = document.createElement("div");
  banner.className = "lost";
  banner.hidden = true;
  banner.textContent = "Connection to the plugin lost — reopen this editor from the key's settings panel in Stream Deck.";
  document.body.prepend(banner);
  const watch = new NativeWebSocket(`ws://127.0.0.1:${cfg.port}`);
  watch.onopen = () => watch.send(JSON.stringify({ event: "registerPropertyInspector", uuid: cfg.uuid }));
  watch.onclose = () => { banner.hidden = false; };

  window.connectElgatoStreamDeckSocket(cfg.port, cfg.uuid, "registerPropertyInspector", JSON.stringify(cfg.info), JSON.stringify(cfg.actionInfo));

  const { streamDeckClient: sd } = SDPIComponents;
  document.querySelectorAll("button.browse").forEach((btn) => {
    btn.addEventListener("click", () => sd.send("sendToPlugin", { event: "pickFile", setting: btn.dataset.setting }));
  });
  sd.sendToPropertyInspector.subscribe((ev) => {
    const p = ev.payload;
    if (!p || p.event !== "pickedFile") return;
    const field = document.querySelector(`sdpi-textfield[setting="${CSS.escape(p.setting)}"]`);
    if (field) field.value = p.path;
  });
})();
