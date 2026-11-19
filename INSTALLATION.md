# Installation – Ski Bum's Delight

Das Tool läuft lokal im Browser. Es braucht nur **Python** (ab 3.9) und eine
Internetverbindung, sonst nichts: keine Zusatzpakete, kein Konto, kein API-Schlüssel.

## 1. Python installieren (falls noch nicht da)

Prüfen im Terminal (Windows: PowerShell, Mac: Terminal):

```
python --version
```

Auf dem Mac heisst der Befehl meist `python3 --version`. Kommt eine Version ab 3.9, weiter
mit Schritt 2.

- **Windows:** <https://www.python.org/downloads/> herunterladen und installieren. Im ersten
  Fenster des Installers **„Add python.exe to PATH“** anhaken.
- **Mac:** ebenfalls über <https://www.python.org/downloads/>, oder mit Homebrew
  `brew install python`.

## 2. ZIP entpacken

Das ZIP an einen beliebigen Ort entpacken, z.B. in den Ordner „Dokumente“. Es entsteht ein
Ordner `ski-bums-delight`.

## 3. Server starten

Im Terminal in den Ordner wechseln und den Server starten:

**Windows (PowerShell)**

```
cd $HOME\Documents\ski-bums-delight
python serve.py
```

**Mac (Terminal)**

```
cd ~/Documents/ski-bums-delight
python3 serve.py
```

Den Pfad anpassen, falls du das ZIP woanders entpackt hast. Das Terminalfenster muss offen
bleiben, solange du das Tool benutzt. Beenden mit `Ctrl+C`.

## 4. Im Browser öffnen

<http://127.0.0.1:8765>

Chrome oder Edge funktionieren sicher; Firefox und Safari sind nicht getestet.

## Häufige Probleme

| Problem | Lösung |
|---|---|
| `python` wird nicht gefunden | Windows: Python neu installieren mit „Add to PATH“, dann ein neues Terminal öffnen. Mac: `python3` statt `python` |
| Stationen fehlen, Rest geht | Seite wurde per Doppelklick auf `index.html` geöffnet. Immer über `serve.py` und die Adresse oben |
| „Address already in use“ | Port ist besetzt: `python serve.py 8766` und dann <http://127.0.0.1:8766> öffnen |
| Gelände lädt langsam | Die Daten kommen live von swisstopo, SLF und Copernicus; beim ersten Laden dauert es etwas |

## Was drin ist

- `README.md` – Dokumentation: Funktionen, Datenquellen, bekannte Grenzen (englisch)
- `serve.py` – lokaler Server, nur auf diesem Rechner erreichbar
- `web/` – die Seite selbst
- `web/samples/` – eine Beispielroute (Winterhorn ab Hospental) zum Testen des GPX-Imports
- `tests/` – Server-Tests (`python -m unittest discover -s tests`)

> **Nur eine Planungshilfe.** Das Tool ersetzt weder die eigene Lawinenbeurteilung im
> Gelände noch das vollständige SLF-Bulletin.
