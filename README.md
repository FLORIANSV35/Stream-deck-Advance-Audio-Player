# SAAP Audio — plugin Stream Deck (macOS)

Lecteur audio avancé pour Stream Deck.

## Installation (utilisateurs)
1. Télécharge **`com.saap.audio.streamDeckPlugin`** depuis la [dernière release](../../releases/latest).
2. Double-clique dessus : l'application Stream Deck l'installe.
3. Cherche la catégorie **SAAP Audio** dans la liste des actions.

Prérequis : macOS 12 ou plus (Apple Silicon et Intel), Stream Deck 6.5 ou plus.

> Le moteur audio n'est pas notarisé par Apple. Le plugin retire lui-même l'étiquette de quarantaine au démarrage,
> mais si macOS affiche « Apple n'a pas pu vérifier saap-engine », ouvre Réglages Système → Confidentialité et sécurité
> et clique sur « Ouvrir quand même ».

## Fonctions
- **Lire un son** (touche) : plusieurs fichiers en même temps (mono ou stéréo), fondu d'entrée / de sortie,
  cut d'entrée / de sortie (points de découpe dans le fichier), boucle, volume par fichier réglable en direct,
  **interface audio et canaux de sortie choisis par fichier** (stéréo 1-2, 3-4… ou mono sur un canal),
  décompte / temps écoulé + barre de progression sur la touche, comportement de l'appui (arrêt, pause, relance).
- **Volume** (touche ou cadran) : volume général ou par groupe de sons, mute. Cadran : rotation = volume, appui = mute.
- **Tout arrêter** (touche) : tous les sons ou un groupe, avec fondu ou coupure.
- **Groupes** : un nom libre par son ; « arrêter les autres sons du groupe » permet des lancements exclusifs.

## Architecture
- `engine/` : moteur audio natif en Objective-C (AVAudioEngine, un moteur par lecture, routage par channel map CoreAudio).
  Dialogue en JSON ligne par ligne sur stdin/stdout.
- `plugin/` : plugin TypeScript (SDK Elgato) qui lance le moteur, pilote les touches/cadrans et sert l'inspecteur.

## Build
```bash
./engine/build.sh                 # compile bin/saap-engine
cd plugin && npm install && npm run build   # bundle bin/plugin.js
```

## Créer le paquet à distribuer
```bash
./package.sh    # → dist/com.saap.audio.streamDeckPlugin
```

## Installation en développement
```bash
ln -s "$PWD/plugin/com.saap.audio.sdPlugin" "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.saap.audio.sdPlugin"
```
Puis quitter et relancer l'application Stream Deck. Les logs sont dans `com.saap.audio.sdPlugin/logs/`.
