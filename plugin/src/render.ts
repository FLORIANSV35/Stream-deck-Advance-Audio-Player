// Rendu des touches : SVG 144×144 avec un système visuel commun (fond dégradé, anneau, palette unique).

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const uri = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const fmtTime = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const C = {
  bgTop: "#1d2027", bgBottom: "#0d0f13",
  text: "#eceef2", muted: "#7d8494", faint: "#2a2e37",
  green: ["#5eead4", "#22c55e"], amber: ["#fde68a", "#f59e0b"], red: ["#fca5a5", "#ef4444"], blue: ["#93c5fd", "#3b82f6"],
} as const;
type Accent = readonly [string, string];

const FONT = `-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif`;
const MONO = `'SF Mono', Menlo, monospace`;

/** Cadre commun : fond dégradé, liseré clair en haut, dégradés d'accent. */
const frame = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bgTop}"/><stop offset="1" stop-color="${C.bgBottom}"/></linearGradient>
    ${([["g", C.green], ["a", C.amber], ["r", C.red], ["b", C.blue]] as const)
      .map(([id, [from, to]]) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`)
      .join("")}
  </defs>
  <rect width="144" height="144" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="143" height="143" rx="0" fill="none" stroke="#ffffff" stroke-opacity="0.06"/>
  ${body}
</svg>`;

const text = (x: number, y: number, size: number, fill: string, s: string, o: { weight?: number; mono?: boolean; spacing?: number; fit?: number } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${o.weight ?? 500}" fill="${fill}" text-anchor="middle" font-family="${o.mono ? MONO : FONT}" letter-spacing="${o.spacing ?? 0}"${o.fit ? ` textLength="${o.fit}" lengthAdjust="spacingAndGlyphs"` : ""}>${esc(s)}</text>`;

/** Nom en gros en haut de la touche : la taille s'adapte à la longueur, puis le texte est resserré (jusqu'à 30 %) avant d'être tronqué. */
function title(label: string, y = 29, base = 25): string {
  const W = 132, K = 0.56; // largeur dispo, largeur moyenne d'un caractère (en fraction de la taille)
  let size = base;
  while (size > 18 && label.length * K * size > W) size -= 1;
  const shown = clip(label, Math.max(4, Math.floor((W * 1.3) / (K * size))));
  const squeeze = shown.length * K * size > W;
  return text(72, y, size, C.text, shown, { weight: 700, fit: squeeze ? W : undefined });
}

/** Anneau de progression centré en (72, 78). */
const RING_R = 39;
const RING_C = 2 * Math.PI * RING_R;
const ring = (progress: number, grad: string) => `
  <circle cx="72" cy="78" r="${RING_R}" fill="none" stroke="${C.faint}" stroke-width="7"/>
  ${progress > 0 ? `<circle cx="72" cy="78" r="${RING_R}" fill="none" stroke="url(#${grad})" stroke-width="7" stroke-linecap="round"
    stroke-dasharray="${(Math.max(0.02, Math.min(1, progress)) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}" transform="rotate(-90 72 78)"/>` : ""}`;

export interface PlayView {
  label: string;
  state: "idle" | "playing" | "paused";
  /** texte central quand une lecture est active */
  time?: string;
  /** 0-1 */
  progress?: number;
  group?: string;
  /** nombre de pistes configurées */
  tracks?: number;
  loop?: boolean;
}

export function playKey(v: PlayView): string {
  const active = v.state !== "idle";
  const grad = v.state === "paused" ? "a" : "g";
  const footer = [v.group, v.tracks && v.tracks > 1 ? `×${v.tracks}` : ""].filter(Boolean).join("  ·  ");

  const center = active
    ? text(72, 84, 21, v.state === "paused" ? C.amber[0] : C.text, v.time ?? "", { weight: 600, mono: true, spacing: -0.5 })
    : `<path d="M62 62 L62 94 L90 78 Z" fill="url(#g)" stroke="url(#g)" stroke-width="5" stroke-linejoin="round"/>`;
  // mention sous le temps : PAUSE (ambre) ou BOUCLE
  const hint = v.state === "paused" ? text(72, 103, 11, C.amber[1], "PAUSE", { weight: 700, spacing: 1.5 })
    : active && v.loop ? text(72, 103, 11, C.muted, "BOUCLE", { weight: 700, spacing: 1.5 }) : "";

  return uri(frame(`
    ${title(v.label)}
    ${ring(active ? (v.progress ?? 0) : 0, grad)}
    ${center}${hint}
    ${footer ? text(72, 137, 14, C.muted, clip(footer, 16), { weight: 500 }) : ""}
  `));
}

export function volumeKey(o: { target: string; icon: "up" | "down" | "mute" | "set"; pct: number; muted: boolean }): string {
  const accent = o.muted ? "r" : "g";
  const glyph = {
    up: `<path d="M56 74 L72 56 L88 74" fill="none" stroke="url(#${accent})" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
    down: `<path d="M56 56 L72 74 L88 56" fill="none" stroke="url(#${accent})" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
    mute: `<path d="M50 60 h12 l16 -13 v42 l-16 -13 h-12 z" fill="url(#${accent})"/><path d="M90 58 l16 20 M106 58 l-16 20" stroke="${C.red[1]}" stroke-width="6" stroke-linecap="round"/>`,
    set: `<rect x="52" y="56" width="40" height="7" rx="3.5" fill="url(#${accent})"/><rect x="52" y="70" width="40" height="7" rx="3.5" fill="url(#${accent})"/>`,
  }[o.icon];
  const level = o.muted ? 0 : o.pct / 100;
  return uri(frame(`
    ${text(72, 24, 16, C.muted, clip(o.target === "*" ? "GÉNÉRAL" : o.target.toUpperCase(), 12), { weight: 600, spacing: 1.2 })}
    <g transform="translate(${o.icon === "mute" ? -6 : 0} ${o.icon === "mute" ? 0 : -2})">${glyph}</g>
    ${text(72, 112, 30, o.muted ? C.red[0] : C.text, o.muted ? "MUTE" : `${o.pct}%`, { weight: 700, mono: true, spacing: -0.5 })}
    <rect x="22" y="123" width="100" height="6" rx="3" fill="${C.faint}"/>
    ${level > 0 ? `<rect x="22" y="123" width="${(100 * level).toFixed(1)}" height="6" rx="3" fill="url(#g)"/>` : ""}
  `));
}

export function stopKey(o: { label: string; group?: string; mode?: "fade" | "cut"; fade?: number }): string {
  const cut = o.mode === "cut";
  // coupure : anneau plein ; fondu : anneau qui s'efface
  const rim = cut
    ? `<circle cx="72" cy="80" r="${RING_R}" fill="none" stroke="url(#r)" stroke-width="7"/>`
    : `<circle cx="72" cy="80" r="${RING_R}" fill="none" stroke="${C.faint}" stroke-width="7"/>
       <circle cx="72" cy="80" r="${RING_R}" fill="none" stroke="url(#r)" stroke-width="7" stroke-linecap="round"
         stroke-dasharray="${(0.62 * RING_C).toFixed(1)} ${RING_C.toFixed(1)}" transform="rotate(-90 72 80)" opacity="0.9"/>`;
  const footer = [o.group, cut ? "coupure" : o.group ? "fondu" : `fondu ${o.fade ?? 1.5} s`].filter(Boolean).join("  ·  ");
  return uri(frame(`
    ${title(o.label)}
    ${rim}
    <rect x="57" y="65" width="30" height="30" rx="7" fill="url(#r)"/>
    ${text(72, 138, 13, C.muted, clip(footer, 20), { weight: 500 })}
  `));
}

export function seekKey(o: { dir: 1 | -1; seconds: number; group: string }): string {
  const chevron = (x: number) =>
    `<path d="M${x} 58 L${x + (o.dir > 0 ? 16 : -16)} 76 L${x} 94" fill="none" stroke="url(#b)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
  const glyph = o.dir > 0 ? chevron(52) + chevron(78) : chevron(92) + chevron(66);
  return uri(frame(`
    ${text(72, 24, 16, C.muted, clip((o.group || "TOUS LES SONS").toUpperCase(), 14), { weight: 600, spacing: 1.2 })}
    ${glyph}
    ${text(72, 124, 26, C.text, `${o.dir > 0 ? "+" : "−"}${o.seconds} s`, { weight: 700, mono: true, spacing: -0.5 })}
  `));
}
