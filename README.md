# 🍿 couchmatch

**Tinder für den Filmabend.** Filter wählen, Link schicken, gemeinsam swipen —
am Ende seht ihr, welche Filme und Serien ihr beide sehen wollt.

[![CI & Docker](https://github.com/Lukas20039/couchmatch/actions/workflows/docker.yml/badge.svg)](https://github.com/Lukas20039/couchmatch/actions/workflows/docker.yml)

- **Keine API-Keys, Konto optional.** Im Hintergrund baut couchmatch eine lokale
  Datenbank mit ~17.000 Filmen und Serien aus dem freien
  [Cinemeta](https://v3-cinemeta.strem.io)-Katalog auf: IMDb-Bewertung, Genres,
  Laufzeit, Beschreibung, Poster und YouTube-Trailer.
- **Stimmungs-Vorlagen:** 😂 Leicht & lustig · 💘 Date Night · 😱 Nervenkitzel ·
  💥 Action · 🔎 Krimi-Abend · 🧠 Was zum Nachdenken · 😢 Zum Mitfühlen ·
  🛋️ Hirn aus · 🌍 Doku-Abend — füllen Genres, Bewertung und Länge vor.
- **Vorauswahl:** Filme und/oder Serien · 🔥 Gerade beliebt · 🆕 Neu
  (12 Monate) · ⭐ Top bewertet · 🏛️ All-time Klassiker · 💎 Geheimtipps ·
  Genres rein/raus · Mindestbewertung · Zeitraum · Filmlänge.
- **Stapelgröße:** 5 bis 200 zufällige Titel aus dem gefilterten Pool.
- **Swipen:** → Like · ← Nope · ↑ Super-Like (pro Person begrenzbar) ·
  ↓ „Sieht interessant aus" — oder per Buttons/Pfeiltasten, mit Rückgängig.
- **Live zu zweit (oder mehr):** Einladungslink, Fortschritt der anderen,
  „It's a Match!" erscheint sofort bei allen.
- **Ergebnis:** Volltreffer und Vielleicht-Matches, sortiert, mit Trailer,
  IMDb-Link und „Wo streamen?" (JustWatch). 🎲 wählt einen Match für euch aus.
- **🚫 Veto-Joker:** pro Person einstellbar viele — streicht einen Match für
  alle („den schau ich sicher nicht"), lässt sich zurücknehmen.
- **🏆 Finale:** zu viele Matches? K.-o.-Duelle „Was lieber?", beide wählen
  live. Uneinig → höherer Match-Score gewinnt, bei Gleichstand eine Münze —
  bis genau ein Film übrig bleibt.
- **👤 Konten (optional):** Benutzername + Passwort. Konten fragen sich
  gegenseitig an (per Benutzername oder Verbindungslink), danach lädt man sich
  direkt zu Sessions ein — die Einladung erscheint live im Konto. Mit Konto
  kommt man von jedem Gerät zurück in seine Sessions. Gäste per Link gehen
  weiterhin ohne Konto.
- **📌 Watchlists:** jedes Konto hat eine eigene, jedes verbundene Paar eine
  gemeinsame. Beide bewerten jeden Titel mit einer Wichtigkeit
  (👎 eher nicht · 🙂 gern mal · 😍 will ich · 🔥 unbedingt) — oben steht,
  worauf ihr beide am meisten Lust habt, 💞 markiert gemeinsame Favoriten.
  Titel kommen per Suche dazu, mit 📌 direkt aus einer Session
  („Alle Volltreffer merken") oder ✍️ selbst eingetragen (Name, Jahr,
  optional IMDb-Link) — auch was der Katalog nicht kennt.
- **📲 Aus TikTok, Instagram & YouTube:** im Video auf „Teilen" →
  couchmatch. Die Caption wird nach dem Titel durchsucht („Film: …",
  Anführungszeichen, Hashtags, Titel im Text), ein Tipp setzt ihn auf die
  Watchlist, der Link landet als Kommentar dabei. Funktioniert auf Android
  mit installierter App; iPhone kennt PWAs nicht als Teilen-Ziel — dort den
  Link unter `/teilen` einfügen. Instagram gibt die Caption nicht immer
  heraus, dann einfach suchen.
- **Pro Titel:** 🚫 Veto (fliegt aus Zufallstipp und gemeinsamen Sessions,
  zurücknehmbar) und 💬 Kommentare.
- **Aktivität:** ein Verlauf pro Watchlist mit „neu"-Markierung — hinzugefügt,
  kommentiert, Veto, gesehen, Sterne. Auf alles lässt sich mit Smileys
  reagieren (❤️ 😂 😍 🔥 👍 👎 😱 🙄 🍿).
- **🔔 Push-Benachrichtigungen** (Web Push, ohne Fremddienst-Konto): wenn
  dein Gegenüber etwas hinzufügt, kommentiert, ein Veto einlegt oder
  reagiert, bei Anfragen und Session-Einladungen. Mehrere Titel auf einmal
  werden zu einer Nachricht gebündelt. Auf iPhone/iPad erst „Zum
  Home-Bildschirm" hinzufügen.
- **📊 Admin-Statistik** unter `/admin`: Konten, aktive Nutzer, Paare,
  Watchlists, Sessions, Verlauf pro Tag, meistgemerkte Titel — ohne Inhalte
  einzelner Listen.
- **Aus der Watchlist:** 🎬 eine Session nur aus euren offenen Titeln
  (inkl. Veto & Finale) oder 🎲 „Was schauen wir heute?" — gewichteter Zufall,
  „eher nicht" bleibt außen vor. Gesehenes bekommt ⭐ Sterne von beiden und
  wird beim nächsten Setup auf Wunsch ausgeblendet.
- **Privat:** Stimmen der anderen siehst du nur, wenn daraus ein Match wird.
  Kein Tracking, keine externen Skripte; das einzige Cookie ist die Anmeldung.

---

## Selbst hosten

Das fertige Image liegt in der GitHub Container Registry, für `amd64` und
`arm64` (läuft also auch auf einem Raspberry Pi 4/5):

```
ghcr.io/lukas20039/couchmatch:latest
```

### Schnellstart mit Docker

```sh
docker run -d --name couchmatch --restart unless-stopped \
  -p 8095:8095 -v couchmatch-data:/data \
  ghcr.io/lukas20039/couchmatch:latest
```

Dann `http://<server-ip>:8095` öffnen. Beim allerersten Start lädt couchmatch
die Film-Datenbank (ca. 30 Sekunden, die Seite zeigt den Fortschritt).

### Mit Docker Compose

`docker-compose.yml` anlegen (oder aus diesem Repo nehmen):

```yaml
services:
  couchmatch:
    image: ghcr.io/lukas20039/couchmatch:latest
    container_name: couchmatch
    restart: unless-stopped
    ports:
      - "8095:8095"
    volumes:
      - couchmatch-data:/data

volumes:
  couchmatch-data:
```

```sh
docker compose up -d          # starten
docker compose pull && docker compose up -d   # aktualisieren
docker compose logs -f        # Logs
```

### Von außen erreichbar machen

Damit dein Gegenüber den Einladungslink auch unterwegs öffnen kann, muss
couchmatch aus dem Internet erreichbar sein. Der Link wird aus der Adresse
gebaut, unter der du die Seite geöffnet hast — öffne sie also über die
öffentliche Adresse, bevor du eine Session erstellst.

**Variante A — eigene Domain mit Caddy (HTTPS automatisch):**

```yaml
services:
  couchmatch:
    image: ghcr.io/lukas20039/couchmatch:latest
    restart: unless-stopped
    volumes:
      - couchmatch-data:/data

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    command: caddy reverse-proxy --from filme.example.org --to couchmatch:8095
    volumes:
      - caddy-data:/data

volumes:
  couchmatch-data:
  caddy-data:
```

Der DNS-Eintrag von `filme.example.org` muss auf deinen Server zeigen, Ports
80 und 443 müssen offen sein.

**Variante B — ohne Domain und ohne offene Ports, per Cloudflare Tunnel:**

```sh
docker run --rm --network host cloudflare/cloudflared:latest \
  tunnel --url http://localhost:8095
```

Gibt eine zufällige `https://….trycloudflare.com`-Adresse aus — gut für einen
spontanen Filmabend. Für eine feste Adresse einen benannten Tunnel in deinem
Cloudflare-Konto anlegen.

**Variante C — nginx** als bestehender Reverse Proxy: Live-Updates laufen über
Server-Sent Events, deshalb Pufferung abschalten:

```nginx
location / {
    proxy_pass http://127.0.0.1:8095;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

### Konfiguration

| Variable   | Standard  | Bedeutung                                      |
| ---------- | --------- | ---------------------------------------------- |
| `PORT`     | `8095`    | HTTP-Port im Container                         |
| `HOST`     | `0.0.0.0` | Bind-Adresse                                   |
| `DATA_DIR` | `/data`   | Film-Datenbank (`catalog.json`), Sessions (`rooms.json`), Konten & Watchlists (`couchmatch.db`) |
| `SIGNUP`   | `open`    | `closed` = keine neuen Konten (bestehende melden sich weiter an) |
| `ADMIN_USERS` | —      | Benutzernamen mit Zugriff auf `/admin`, kommagetrennt. Ohne Angabe ist das erste angelegte Konto Admin |
| `VAPID_SUBJECT` | Projekt-URL | Kontakt für Push-Dienste (`mailto:…` oder `https://…`) |

Alles liegt in einem Container und einem Volume — Konten und Watchlists in
einer SQLite-Datei (über das in Node eingebaute `node:sqlite`, kein extra
Datenbank-Container). Passwörter werden mit scrypt gehasht; Anmeldungen
gelten 180 Tage. Läuft couchmatch hinter HTTPS, setzt der Reverse Proxy
`X-Forwarded-Proto: https`, damit das Cookie als `Secure` markiert wird.

Push-Benachrichtigungen brauchen HTTPS (oder `localhost`). Die Schlüssel dafür
(`vapid.json`) entstehen beim ersten Start im Volume — geht die Datei
verloren, muss Push auf jedem Gerät neu aktiviert werden.

Sessions werden nach 30 Tagen ohne Aktivität verworfen. Die Film-Datenbank
aktualisiert sich täglich von selbst. Backup = das Volume `/data` sichern
(für eine konsistente Kopie der Datenbank im laufenden Betrieb:
`sqlite3 /data/couchmatch.db ".backup backup.db"`).

### Ohne Docker

Node.js ≥ 22.13, keine weiteren Abhängigkeiten:

```sh
git clone https://github.com/Lukas20039/couchmatch.git
cd couchmatch
npm start
```

---

## Entwicklung

```sh
npm start                 # startet auf :8095, Daten in ./data
npm test                  # Match-Logik, Veto, Finale, Filter, Konten, Watchlists, Push
npm run smoke             # API-Durchlauf mit zwei Spielern gegen laufenden Server
# UI-Test mit zwei simulierten Handys (braucht Playwright + Chromium):
PLAYWRIGHT=…/playwright-core/index.mjs CHROMIUM=…/chrome node scripts/e2e.mjs
# Konten, Anfragen, Watchlist, Direkt-Einladung (frischer Server mit leerer DB):
PLAYWRIGHT=… CHROMIUM=… node scripts/e2e-accounts.mjs
# Teilen aus TikTok & Co. (frischer Server, YouTube-Teil braucht Internet):
PLAYWRIGHT=… CHROMIUM=… node scripts/e2e-share.mjs
```

| Datei             | Inhalt                                                   |
| ----------------- | -------------------------------------------------------- |
| `server.js`       | HTTP-Server, API, Live-Stream (SSE), statische Dateien   |
| `lib/catalog.js`  | Katalog-Crawl, Kategorien, Filter, Titel im Text erkennen |
| `lib/share.js`    | Geteilte Links auflösen (TikTok/YouTube-oEmbed, Instagram) |
| `lib/rooms.js`    | Sessions, Stimmen, Matches, Veto, Finale                 |
| `lib/accounts.js` | SQLite: Konten, Verbindungen, Watchlists, Verlauf, Statistik |
| `lib/push.js`     | Web Push: VAPID-Signatur, Verschlüsselung (RFC 8291), Texte |
| `public/`         | Frontend (Vanilla JS, kein Build-Schritt)                |

Jeder Push auf `main` baut und veröffentlicht `:latest`; ein Tag `v1.2.3`
erzeugt zusätzlich `:1.2.3` und `:1.2`.

**Hinweis:** Die Beschreibungen kommen von Cinemeta und sind englisch.

## Lizenz

MIT — Filmdaten und Poster stammen von Cinemeta/Metahub, Trailer von YouTube.
