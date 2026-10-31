# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated. The user asked for "one command, zero npm installs", so the build is Node 22+ with
built-in modules only (no dependencies at all), a hand-written front end in plain HTML, CSS and
JavaScript, and exactly two external tools the machine already has: Google Chrome and ffmpeg.
No bundler, no framework, no build step.

## Users

One person on their own computer. They have a page open with a video in it and want the file —
a lecture they are enrolled in, a clip they need offline, their own upload on someone else's
platform. They are comfortable running a command, they are not running a media operation, and
they are not going to make an account or upload a URL to a stranger's server to do it.

Job: get the actual media file out of a page that does not offer a download link, quickly, once,
without installing a suite of tools or trusting a third-party download site with the URL.

## Product Purpose

Pluck drives an isolated Chrome window beside any page the user pastes, watches every media
request that page makes, reads the real duration, resolution and size out of the bytes rather
than guessing from filenames, and saves the stream the user picks as one file on their own disk.

Success is one sentence from the user: the file is on my disk, it plays, and it is the quality I
picked. Failure is a download that silently stops at 40%, a stream list full of ad pre-rolls, or
a saved file that turns out to be a 200-byte error page.

## Positioning

A hosted video-downloader site has to receive the URL, fetch the media on its own servers, and
keep the file on its own storage before the user can have it. Pluck never sees the URL. The
browser talking to the site is the same machine that writes the file, so the session cookies the
host checks for are genuinely present, the bytes never leave the machine, and there is no upload
step, no queue, no account, and no operator that could log what was downloaded.

That is a mechanism a hosted clone could not truthfully claim even if it copied every feature.

## Operating Context

- One local Node process serving `http://127.0.0.1:7777`; the user opens that address in a browser.
- A throwaway Chrome profile in the OS temp folder, launched per session and destroyed with it.
- A five-minute live window per session (default, configurable), counted down in the interface.
- Downloads are jobs: they keep running after the window closes, and are saved through the browser.
- ffmpeg is present on most machines but not guaranteed; HLS and DASH need it for a clean MP4.
- The user is expected to already have Chrome; the app names the missing dependency instead of
  installing anything.
- Intended for media the user has the right to keep. DRM-protected streams are out of scope and
  the interface says so rather than offering a workaround.
- Runs on one person's machine by default. It can be deployed to a VPS the operator controls,
  with `PLUCK_PASSWORD` set, but it cannot run on PHP-style shared hosting: that shape has no
  long-lived process, no browser binary, and no ffmpeg.

## Capabilities and Constraints

Confirmed capabilities:

- Live remote window: Chromium screencast to a canvas, with every mouse, wheel, keyboard and text
  input forwarded to the real page, plus back / forward / reload / scroll controls.
- Stream detection from network traffic: progressive MP4 / WebM / MOV / M4A, HLS (`m3u8`), DASH
  (`mpd`), plus transport segments rolled up under their playlist.
- Real metadata: duration, resolution, bitrate and size read by opening the file (MP4 atom walk,
  playlist and manifest parse), never parsed out of the URL.
- Filters and ordering by container and by size / duration / recency, with a priority ordering
  that promotes the stream the page actually played and demotes sub-2 MB fragments and pre-rolls.
- Thumbnails when the page exposes a poster image; in-place preview for progressive files.
- Downloads: parallel ranged chunks with retry for direct files; segment fetch, optional AES-128
  decryption, join and ffmpeg remux for HLS; fragment fetch with init segment and video+audio mux
  for DASH. Progress, speed, elapsed time, percent, cancel, and a filename built from the page
  host and title.
- Session hygiene: popup blocking, unsolicited cross-site navigation blocking with an explicit
  one-time approval, and a per-session timer with expiry.

Confirmed constraints and recorded decisions:

- No cloud-save connectors (Google Drive, Dropbox, OneDrive). They require the operator to own
  OAuth client credentials and a paid quota, which contradicts "100% free" and out-of-box
  operation. Deliberately omitted, not forgotten.
- No accounts, no ads, no analytics, no telemetry, no remote service of any kind.
- DRM (Widevine and friends) is unsupported and stays unsupported.
- Zero npm dependencies is a hard constraint, not a preference.
- Undecided: whether the project ever ships a packaged binary instead of `node server/index.js`.

## Brand Commitments

The name is Pluck. The user asked for the same functionality as the reference site with a
different interface, so nothing from that site's identity — its name, its copy, its green
gradient look, its Bootstrap chrome — carries over.

## Evidence on Hand

No testimonials, customers, benchmarks, press or usage numbers exist, and none may be invented.

Real engineering evidence that copy may reference:

- HLS end-to-end verified: 1080p variant, 634 s, 488 MB output, H.264 + AAC, valid `ftyp` brand.
- DASH end-to-end verified: 1080p video and separate audio adaptation muxed, 193 s, 131 MB.
- Progressive download verified against a live page, served as an attachment with a slugged name.

## Product Principles

1. **The machine is the product.** Anything that would require a server of ours, an account, or a
   subscription is out, even when it would be easier to build.
2. **Read the bytes, do not trust the label.** Duration, resolution and size come from the media
   itself; a guess presented as a fact is worse than an honest blank.
3. **Show the real thing.** The window is the actual page, the progress is the actual byte count,
   and a failure says what the host said.
4. **Never lose a download.** Retries, resume-per-chunk, and a raw fallback when ffmpeg is missing.
5. **The user's own machine, the user's own rules.** Block what the page tries to do behind their
   back, and explain every block instead of silently swallowing it.

## Accessibility & Inclusion

- The remote window is a keyboard-reachable control: focus enters it with Tab, every key is
  forwarded, and Escape releases focus so the user is never trapped inside a canvas.
- Visible focus on every control; no focus outlines removed.
- Honor `prefers-reduced-motion`: the screencast still updates, transitions and entrance motion stop.
- Body text meets WCAG AA contrast on the dark surface; state is never carried by color alone
  (labels, counts and text accompany every colored dot, badge or bar).
