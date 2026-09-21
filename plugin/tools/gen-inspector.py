#!/usr/bin/env python3
"""Génère les panneaux de réglage (ui/*.html) : même habillage, pistes répétées."""
import os
UI = os.path.join(os.path.dirname(__file__), "..", "com.saap.audio.sdPlugin", "ui")
MAX_TRACKS = 6
AUDIO = ".wav,.mp3,.aif,.aiff,.m4a,.aac,.flac,.caf,.mp4"
LOGO = '''<svg viewBox="0 0 36 36"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#22c55e"/></linearGradient></defs>
<rect width="36" height="36" rx="9" fill="#1d2027"/><g fill="url(#lg)"><rect x="7" y="15" width="3" height="6" rx="1.5"/><rect x="12" y="10" width="3" height="16" rx="1.5"/><rect x="17" y="6" width="3" height="24" rx="1.5"/><rect x="22" y="12" width="3" height="12" rx="1.5"/><rect x="27" y="16" width="3" height="4" rx="1.5"/></g></svg>'''

def page(title, subtitle, body, scripts=()):
    tags = "".join(f'\n  <script src="{s}"></script>' for s in scripts)
    return f'''<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>{title}</title>
  <script src="sdpi-components.js"></script>
  <link rel="stylesheet" href="saap.css" />
</head>
<body>
  <header class="hero">{LOGO}<div><h1>{title}</h1><p>{subtitle}</p></div></header>
{body}{tags}
</body>
</html>
'''

def item(label, inner, extra=""):
    return f'    <sdpi-item label="{label}"{extra}>{inner}</sdpi-item>\n'

def card(badge, title, body, *, open=False, cls="", sub="", tag="", subattr=""):
    sub_html = f'<span class="sub"{subattr}>{sub}</span>' if sub or subattr else ""
    tag_html = f'<span class="tag">{tag}</span>' if tag else ""
    return f'''  <details class="card {cls}"{" open" if open else ""}>
    <summary><span class="badge">{badge}</span><span class="meta"><span class="title">{title}</span>{sub_html}</span>{tag_html}</summary>
    <div class="body">
{body}    </div>
  </details>
'''

def track_fields(n):
    k = lambda name: name if n == 1 else f"{name}{n}"
    link = lambda kind: "" if n == 1 else f' data-link="{kind}"'
    out = item("Fichier", f'<sdpi-file setting="{k("file")}" accept="{AUDIO}"></sdpi-file>')
    out += item("Forme d'onde", f'<div class="wave" data-n="{n}"></div>')
    out += item("Sorties", f'<div class="outpick" data-n="{n}"></div>')
    out += item("Volume", f'<sdpi-range setting="{k("volume")}" min="0" max="100" step="1" default="100" showlabels></sdpi-range>', link("volume"))
    out += item("Fondu d'entrée (s)", f'<sdpi-range setting="{k("fadeIn")}" min="0" max="10" step="0.1" default="0" showlabels></sdpi-range>', link("fades"))
    out += item("Fondu de sortie (s)", f'<sdpi-range setting="{k("fadeOut")}" min="0" max="10" step="0.1" default="0" showlabels></sdpi-range>', link("fades"))
    out += item("Cut d'entrée (s)", f'<sdpi-textfield setting="{k("trimIn")}" placeholder="0 = début du fichier" pattern="^[0-9]*[.,]?[0-9]*$"></sdpi-textfield>', link("cut"))
    out += item("Cut de sortie (s)", f'<sdpi-textfield setting="{k("trimOut")}" placeholder="0 = fin du fichier" pattern="^[0-9]*[.,]?[0-9]*$"></sdpi-textfield>', link("cut"))
    out += item("Boucle", f'<sdpi-checkbox setting="{k("loop")}" label="Lire en boucle"></sdpi-checkbox>')
    return out

def play():
    body = '  <sdpi-note>Chaque piste a son fichier et sa sortie. Un appui lance toutes les pistes qui ont un fichier, exactement en même temps.</sdpi-note>\n'
    body += '  <h2 class="section">Pistes</h2>\n'
    for n in range(1, MAX_TRACKS + 1):
        body += card(n, f"Piste {n}", track_fields(n), open=(n == 1),
                     cls="" if n == 1 else "slave", tag="MAÎTRE" if n == 1 else "",
                     subattr=f' data-file="{n}"')
    body += '  <h2 class="section">Liaison</h2>\n'
    body += card("⛓", "Liaison des pistes", 
        item("Cut", '<sdpi-checkbox setting="linkCut" label="Pistes 2-6 : mêmes points de cut que la piste 1"></sdpi-checkbox>') +
        item("Fondus", '<sdpi-checkbox setting="linkFades" label="Pistes 2-6 : mêmes fondus que la piste 1"></sdpi-checkbox>') +
        item("Volume", '<sdpi-checkbox setting="linkVolume" label="Pistes 2-6 : même volume que la piste 1"></sdpi-checkbox>'),
        cls="plain", sub="La piste 1 est le maître")
    body += '  <h2 class="section">Touche</h2>\n'
    body += card("◉", "Comportement", 
        item("Nom affiché", '<sdpi-textfield setting="label" placeholder="Nom de la piste 1 par défaut" maxlength="24"></sdpi-textfield>') +
        item("Appui pendant la lecture", '''<sdpi-select setting="mode" default="stop">
        <option value="stop">Arrêter (avec fondu de sortie)</option>
        <option value="pause">Pause / reprise</option>
        <option value="restart">Relancer depuis le début</option>
      </sdpi-select>''') +
        item("Affichage", '<sdpi-checkbox setting="countdown" label="Décompte (temps restant)" default="true"></sdpi-checkbox>') +
        item("Groupe", '<sdpi-select setting="group" datasource="getGroupsPlay" loading="Chargement…" default="none" placeholder="Aucun groupe"></sdpi-select>') +
        item("Nouveau groupe", '<sdpi-textfield setting="newGroup" placeholder="Saisir un nom puis valider (Entrée)" maxlength="20"></sdpi-textfield>') +
        item("", '<sdpi-checkbox setting="stopOthers" label="Arrêter les autres sons du groupe au lancement"></sdpi-checkbox>'),
        open=True, cls="plain")
    return page("Lire des sons", "Jusqu'à 6 pistes, synchronisées à la milliseconde", body, ["waveform.js", "outputs.js", "links.js"])

def volume():
    body = '  <h2 class="section">Réglage</h2>\n' + card("♪", "Volume en direct",
        item("Cible", '<sdpi-select setting="target" datasource="getGroupsVolume" loading="Chargement…" default="*" placeholder="Général (tous les sons)"></sdpi-select>') +
        item("Touche", '''<sdpi-select setting="mode" default="up">
        <option value="up">Volume +</option>
        <option value="down">Volume −</option>
        <option value="mute">Mute / unmute</option>
        <option value="set">Fixer à une valeur</option>
      </sdpi-select>''') +
        item("Pas (%)", '<sdpi-range setting="step" min="1" max="20" step="1" default="5" showlabels></sdpi-range>') +
        item("Valeur fixée (%)", '<sdpi-range setting="value" min="0" max="100" step="1" default="100" showlabels></sdpi-range>'),
        open=True, cls="plain")
    body += '  <sdpi-note>Sur un cadran : rotation = volume, appui ou toucher = mute. Le pas s\'applique à chaque cran.</sdpi-note>\n'
    return page("Volume", "Général ou par groupe de sons", body)

def stopall():
    body = '  <h2 class="section">Arrêt</h2>\n' + card("■", "Tout arrêter",
        item("Groupe", '<sdpi-select setting="group" datasource="getGroupsStop" loading="Chargement…" default="*" placeholder="Tous les sons"></sdpi-select>') +
        item("Arrêt", '''<sdpi-select setting="mode" default="fade">
        <option value="fade">Avec fondu</option>
        <option value="cut">Coupure immédiate</option>
      </sdpi-select>''') +
        item("Durée du fondu (s)", '<sdpi-range setting="fade" min="0.1" max="10" step="0.1" default="1.5" showlabels></sdpi-range>'),
        open=True, cls="plain")
    return page("Tout arrêter", "Tous les sons, ou un groupe", body)

def seek():
    body = '  <h2 class="section">Déplacement</h2>\n' + card("»", "Avancer / reculer",
        item("Sons concernés", '<sdpi-select setting="group" datasource="getGroupsStop" loading="Chargement…" default="*" placeholder="Tous les sons"></sdpi-select>') +
        item("Touche : sens", '''<sdpi-select setting="direction" default="forward">
        <option value="forward">Avancer</option>
        <option value="back">Reculer</option>
      </sdpi-select>''') +
        item("Touche : saut (s)", '<sdpi-range setting="seconds" min="1" max="60" step="1" default="10" showlabels></sdpi-range>') +
        item("Cadran : saut par cran (s)", '<sdpi-range setting="dialStep" min="1" max="30" step="1" default="2" showlabels></sdpi-range>'),
        open=True, cls="plain")
    body += '  <sdpi-note>Agit sur toutes les lectures du groupe choisi, ensemble et sans décalage. Cadran : rotation = défilement, appui ou toucher = pause / reprise.</sdpi-note>\n'
    return page("Avancer / reculer", "Se déplacer dans la lecture", body)

for name, fn in [("play", play), ("volume", volume), ("stopall", stopall), ("seek", seek)]:
    with open(os.path.join(UI, f"{name}.html"), "w") as f:
        f.write(fn())
print("ok")
