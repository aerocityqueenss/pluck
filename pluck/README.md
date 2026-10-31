# Pluck

Pull the video out of the page. Pluck opens a real Chrome window next to any page you paste,
lists every stream that page asks for, and saves the one you choose as a single MP4 — all on
your own machine, with no account, no upload, and no npm install.

```
node server/index.js          →  http://127.0.0.1:7777
```

## What you need

| Piece | Why | Notes |
| --- | --- | --- |
| **Node 24+** | runs the server | uses only built-in modules; there is no `package.json` to install |
| **Chrome** (or Edge) | the live browser window | Pluck launches it with a throwaway profile in your temp folder |
| **ffmpeg** on your `PATH` | joins HLS/DASH segments into MP4 | without it, playlist downloads are saved as the raw `.ts` stream |

Nothing else. No build step, no bundler, no dependencies to audit.

## Run it

```powershell
cd pluck
node server/index.js
```

Open <http://127.0.0.1:7777>, paste a page address, press **Capture page**.

1. A Chrome window appears to the right of the page, with a real browser session on it.
2. Click inside that window like it is yours: scroll, press play, log in. Every click is
   forwarded to the real page.
3. Every video stream the page requests lands in the signals dock with its protocol,
   resolution, size and duration. Sizes and durations come from reading the file or the
   playlist, not from guessing.
4. Press **Take** and the transfer starts: parallel ranged chunks for direct files, ordered
   segment fetches for playlists, then a remux into one MP4.
5. **Save file** when it finishes. Transfers keep running even after you close the window.

## Settings

All optional, all environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7777` | port the local server listens on |
| `HOST` | `127.0.0.1` | bind address; keep it loopback behind a reverse proxy |
| `PLUCK_PASSWORD` | unset | set it and every page, API call and socket needs that password |
| `PLUCK_CHROME` | first Chrome/Edge found | absolute path to the browser binary |
| `PLUCK_FFMPEG` | `ffmpeg` on `PATH` | absolute path to `ffmpeg` |
| `PLUCK_HEADFUL` | unset | set to `1` to show the browser's own window as well |
| `PLUCK_NO_SANDBOX` | unset | set to `1` only where Chrome cannot sandbox itself |
| `PLUCK_SESSION_SECONDS` | `300` | how long a live window stays open (5 minutes) |
| `PLUCK_MAX_SESSIONS` | `3` | how many live windows can exist at once |

## What it handles

- **Direct files** — MP4, WEBM, MOV, M4V, FLV, MKV: parallel ranged requests, four
  connections, retried chunks, exact byte totals.
- **HLS** — master playlists (every rendition listed and selectable), media playlists,
  `EXT-X-MAP` init segments, AES-128 encrypted playlists (decrypted locally), six segments
  fetched at a time in playlist order.
- **DASH** — every `AdaptationSet` rep, video and audio split, init segments included, matched
  into one file with `-map 0:v:0 -map 1:a:0`.
- **Session facts** — detection deduplicated by URL, live countdown, popup and redirect
  blocking, navigation guard, transfer progress that survives a closed window.

## What it does not do

- **DRM streams.** Widevine, PlayReady and FairPlay hand out encrypted bytes with no local
  key. Pluck will not pretend otherwise, and neither should you.
- **Cloud saves.** Google Drive, Dropbox and OneDrive connectors need an operator account and
  a quota; this build stays local, so the save action writes to your own disk.
- **Anything with an account.** No sign-in, no telemetry, no remote calls except the ones
  your browser already makes to the page you asked for.

Keep only what you have the right to keep.

## Putting it on a server

Pluck is a long-running Node process that starts a real Chrome and calls ffmpeg. That shape
rules out PHP-style shared hosting — Hostinger's ordinary web hosting included — no matter
how the files are uploaded: there is no daemon to keep `node` alive, no Chrome to launch, no
ffmpeg binary to call, and the account's memory and process limits are smaller than one
browser window. Uploading the folder there produces an error page, not a working app.

It runs well on a VPS (Hostinger KVM, any 2 vCPU / 4 GB box) where you have root:

```bash
# Node 24, ffmpeg, and a real Chrome
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o chrome.deb
sudo apt install -y ./chrome.deb

sudo useradd -m -s /bin/bash pluck
sudo rsync -a ./ /home/pluck/app/
sudo chown -R pluck:pluck /home/pluck/app
```

`/etc/systemd/system/pluck.service`:

```ini
[Unit]
Description=Pluck
After=network.target

[Service]
User=pluck
WorkingDirectory=/home/pluck/app
Environment=PORT=7777
Environment=HOST=127.0.0.1
Environment=PLUCK_PASSWORD=change-me
Environment=PLUCK_MAX_SESSIONS=2
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=2
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pluck
```

nginx in front, so the socket upgrade survives and TLS works:

```nginx
location / {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

Then `sudo certbot --nginx -d your.domain` — the client already picks `wss://` on an HTTPS
page, so nothing else changes.

Sizing, honestly: each live window is a Chrome process, roughly 400–600 MB of RAM and a
burst of CPU while it renders. Two sessions on 4 GB is comfortable; three on 2 GB is not.
Disk matters too — a 1080p remux can sit at 1–2 GB per job in the temp folder until you save
it.

**Set `PLUCK_PASSWORD` on any public address.** Without it, Pluck is an unauthenticated
browser-as-a-service: whoever finds the URL browses the web from your server's IP and
downloads through your bandwidth. With it, the browser asks for a name and password once, and
the WebSocket inherits the same cookie. Only add `PLUCK_NO_SANDBOX=1` if Chrome refuses to
start (containers, some root-owned images); it trades a real security boundary for uptime.

### One-command setup on Linux

`deploy/setup-linux.sh` does the apt work for you — ffmpeg, Google Chrome, a generated
password, and the right sandbox flag for a container — then starts the server:

```bash
PLUCK_PASSWORD=change-me bash deploy/setup-linux.sh
```

### GitHub Codespaces

A Codespace is a real Ubuntu machine with `sudo`, so Pluck runs there, and the forwarded port
gives you a public HTTPS URL:

1. Push this folder to a repository, open it in a Codespace.
2. `PLUCK_PASSWORD=change-me bash deploy/setup-linux.sh`
3. In the **Ports** tab, right-click port `7777` → **Port Visibility** → **Public**.
4. Open the `https://<codespace>-7777.app.github.dev` address it offers. The client switches
   to `wss://` on its own.

Free personal accounts get roughly 60 core-hours a month, so a 2-core Codespace runs for
about 30 wall-clock hours, and it stops after 30 minutes idle. Treat it as a demo host, and
keep the password on: a public port is a public URL.

### Container hosts

`deploy/Dockerfile` builds an image with Node 24, Chrome and ffmpeg; `deploy/run-container.sh`
is its entrypoint. One live window needs roughly 500 MB of RAM, so a 512 MB free tier will not
hold it — pick a host that gives you at least 1–2 GB.

Netlify, Vercel and GitHub Pages cannot host Pluck: they serve static files and short-lived
functions, with no long-lived process, no WebSocket, no browser binary and no ffmpeg. GitHub
Actions is a CI runner with no inbound traffic, so it is not a host either.

## Layout

```
pluck/
  server/
    index.js      http routes, static files, api
    ws.js         hand-rolled websocket server (no dependencies)
    session.js    one isolated browser per session: detection, jobs, frames
    browser.js    Chrome launcher and DevTools protocol driver
    analyze.js    mp4 atom walk, HLS and DASH parsing, size and duration probes
    download.js   ranged chunks, segment fetching, AES-128, ffmpeg remux
  public/         index.html, styles.css, app.js, fonts (no framework, no build)
  test/           smoke.mjs, media.js, playlists.mjs, ui.mjs, expiry.mjs, shots.mjs
  DESIGN.md       the visual system: tokens, type ramp, rules
  PRODUCT.md      what this product is and is not
```

## Tests

With the server running:

```powershell
node test/smoke.mjs        # capture a page, download a file, verify ftyp and frames
node test/full.mjs         # pick a rendition, download it, fetch the saved bytes
node test/media.js         # HLS + DASH assembly through the real pipeline
node test/playlists.mjs    # one job per detected playlist, reports each outcome
node test/ui.mjs           # FAQ, notes reveal, filters, preview dialog
node test/expiry.mjs       # short-TTL server; confirms the closed-window state
node test/shots.mjs        # screenshots of every UI state into test/shots/
```

MIT.
