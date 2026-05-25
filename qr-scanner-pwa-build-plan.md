# QR Scanner PWA — Build Plan

A cross-platform Progressive Web App that scans QR codes (e.g. from cans), logs each scanned URL to a live Google Sheet, and works offline by queuing scans until a connection is available.

## Goals

- Works on **both Android and iPhone** from one codebase (PWA, no app stores required).
- Scans QR codes using the device camera.
- Logs each scan to a **live Google Sheet** that syncs across devices.
- Works **offline**: scans are saved locally first and sync automatically when back online.
- Installable to the home screen; launches full-screen like a native app.
- Structured so it can later be wrapped as a Play Store app (TWA) with no rewrite.

## Decisions locked in

| Decision | Choice |
|---|---|
| Platform | PWA (Android + iOS, single codebase) |
| Data destination | Live Google Sheet |
| Offline support | Yes — local-first with sync queue |
| QR decoding | JavaScript library (works on iOS Safari + Android Chrome) |
| Sheet connection | Google Apps Script web app endpoint (no OAuth in app), protected by a shared secret token |
| Duplicate handling | Dedupe rapid repeats only (same can held in frame won't spam rows; a deliberate re-scan still logs) |
| Sync delivery | Idempotent — each scan carries a client-generated unique ID; the script skips IDs it has already written |
| Local storage | IndexedDB (durable on iOS), not `localStorage` |
| Row contents | URL + timestamp + optional note (plus a hidden scan ID for dedupe) |

## Architecture overview

```
[Camera] --> [JS QR decoder] --> [IndexedDB: {id, url, timestamp, note, status}]
                                          |
                                          v
                              [Sync queue watcher]
                                          |
                                  (when online)
                                          v
                  [POST {id, ...} + secret to Apps Script endpoint]
                                          |
                                          v
                    [Script checks secret + skips known IDs]
                                          |
                                          v
                                  [Google Sheet row]
```

The app saves every scan to IndexedDB the instant it happens, so nothing is lost offline and the queue survives iOS storage eviction better than `localStorage`. A background sync routine POSTs any pending scans — each carrying a client-generated unique ID and a shared secret — to the Google Apps Script endpoint. The script rejects requests without the correct secret, and skips any scan ID it has already written, so a network drop after a successful append can't create a duplicate row. Each scan's status (pending / synced) is tracked and shown in the UI so failures are visible rather than silent.

## Why these technology choices

- **PWA over native:** one codebase covers Android and iOS; no app store needed to start.
- **JS QR library (jsQR / html5-qrcode) over native BarcodeDetector:** iOS Safari does not support `BarcodeDetector`, so a JS decoder is the only path that works identically on both platforms.
- **Apps Script endpoint over full Sheets API:** avoids OAuth login flow and API key management; a single deployment URL accepts a POST and appends a row.
- **Shared secret on the endpoint:** the Apps Script URL is otherwise public-by-URL, meaning anyone who sees it could append rows. A secret token sent by the app and checked by the script closes this — cheap now, annoying to retrofit after the URL is baked into a hosted app.
- **`text/plain` POST to dodge CORS preflight:** browsers POSTing cross-origin to Apps Script trigger a preflight `OPTIONS` request that Apps Script handles poorly. Sending the body as `text/plain` (and parsing JSON inside the script) keeps it a "simple" request and avoids the preflight entirely — a known gotcha designed around from the start.
- **Client-generated scan IDs for idempotency:** sync is at-least-once (a network drop after the Sheet appends but before the app hears back would otherwise re-send). A unique ID per scan, with the script skipping IDs it has already seen, makes re-sends safe and prevents phantom duplicate rows.
- **IndexedDB over `localStorage`:** on iOS, Safari can evict `localStorage` for PWAs that haven't been opened recently, risking loss of the unsynced queue. IndexedDB is more durable, making the "never lose a scan" promise actually hold.
- **Visible sync status:** each scan shows pending / synced in the history view, so a silent sync failure becomes immediately obvious rather than invisible data loss.

## Components to build

1. **`index.html`** — the app shell, camera view, scan feedback, scan list/history UI, and optional note field.
2. **Scanner logic** — camera access, continuous QR decode loop, rapid-repeat dedupe.
3. **Local storage layer** — IndexedDB, persisting each scan as `{id, url, timestamp, note, status}` where `status` is pending or synced.
4. **Sync queue** — detects connectivity, POSTs pending scans (as `text/plain` with the secret) to the endpoint, marks them synced on success, retries on failure, and surfaces status in the UI.
5. **`manifest.json`** — app name, icons, theme color, `display: standalone` (required for installability + future TWA).
6. **`service-worker.js`** — caches the app shell so it loads offline; required for PWA installability.
7. **Icons** — home-screen icons in required sizes.
8. **`Code.gs`** — the Google Apps Script that verifies the shared secret, skips already-seen scan IDs, and appends a row to the Sheet.

## Build sequence

1. Build the core scanner in a single HTML file and confirm it decodes QR codes on a phone.
2. Add local-first storage so scans persist and survive offline.
3. Add the optional note field and rapid-repeat dedupe.
4. Write the Apps Script, deploy it as a web app, and wire the sync queue to its URL.
5. Add the manifest, service worker, and icons to make it installable.
6. Test the full offline → online sync cycle on a real device.

## Setup steps for you (after files are built)

1. Create a Google Sheet with header columns: `URL`, `Timestamp`, `Note`, `Scan ID` (the Scan ID column powers duplicate-skipping).
2. Open **Extensions → Apps Script**, paste in `Code.gs`, set your chosen secret token at the top of the script, and deploy it as a web app (execute as you, accessible to anyone with the link).
3. Copy the deployment URL **and the same secret token** into the app's config.
4. Host the app files on a free HTTPS host (GitHub Pages, Netlify, Cloudflare Pages, or Firebase Hosting).
5. Open the hosted URL on your phone and "Add to Home Screen."

## Known constraints / honest caveats

- **iOS camera:** Safari requires HTTPS for camera access (covered by any of the suggested hosts) and a user tap to start the camera.
- **JS decoding** is slightly less efficient than native, but fine for occasional scanning.
- **Apps Script endpoint** is protected by a shared secret, which is sufficient for personal use. The secret travels in the request body over HTTPS. If this ever becomes multi-user or handles sensitive data, move to proper per-user auth (OAuth / Sheets API).
- **App Store route (later):** wrapping as a TWA is possible from this exact codebase, but nicotine-related apps face extra review scrutiny — framing as a generic QR logger helps.

## Possible later enhancements

- Export to CSV as a backup alongside the Sheet.
- Edit or delete logged scans from the history view.
- Scan-count tally per unique URL.
- TWA wrapper + Play Store submission.
