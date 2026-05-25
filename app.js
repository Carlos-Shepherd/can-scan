/* ============================================================
   Can Scan — main app
   - QR scanning via html5-qrcode
   - Local-first persistence via IndexedDB
   - Idempotent sync to a Google Apps Script endpoint
   ============================================================ */

(function () {
  "use strict";

  const DB_NAME = "can-scan";
  const DB_VERSION = 1;
  const STORE = "scans";
  const REPEAT_WINDOW_MS = 1500; // ignore identical scan within this window

  // ---------- IndexedDB layer ----------

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function putScan(scan) {
    return tx("readwrite", (store) => store.put(scan));
  }

  function getAllScans() {
    return tx("readonly", (store) => new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function getPendingScans() {
    return tx("readonly", (store) => new Promise((resolve, reject) => {
      const idx = store.index("status");
      const req = idx.getAll(IDBKeyRange.only("pending"));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  // ---------- Helpers ----------

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // RFC4122 v4 fallback for older Safari
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return time;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (_) { /* ignore */ }
    }
  }

  // Extracts the last path segment from a URL. Trailing slashes, query strings,
  // and fragments are stripped. For non-URL input, returns the text after the
  // last "/" (or the whole string if there isn't one). Falls back to "" if empty.
  function extractCode(text) {
    if (!text) return "";
    try {
      const u = new URL(text);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || "";
    } catch (_) {
      const m = String(text).trim().match(/[^/]+$/);
      return m ? m[0] : "";
    }
  }

  // ---------- UI ----------

  const els = {
    startBtn: document.getElementById("start-btn"),
    stopBtn: document.getElementById("stop-btn"),
    syncBtn: document.getElementById("sync-btn"),
    noteInput: document.getElementById("note-input"),
    lastScanSection: document.getElementById("last-scan-section"),
    lastScan: document.getElementById("last-scan"),
    history: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    connection: document.getElementById("connection-status"),
    toast: document.getElementById("toast"),
    flash: document.getElementById("scan-flash"),
  };

  let flashTimer = null;
  function flashSuccess() {
    if (!els.flash) return;
    els.flash.classList.add("visible");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => els.flash.classList.remove("visible"), 220);
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 2400);
  }

  function renderConnection() {
    const online = navigator.onLine;
    els.connection.classList.toggle("online", online);
    els.connection.classList.toggle("offline", !online);
    els.connection.querySelector(".label").textContent = online ? "online" : "offline";
  }

  function renderLastScan(scan) {
    els.lastScanSection.hidden = false;
    els.lastScan.innerHTML = "";
    const code = document.createElement("div");
    code.className = "code";
    code.textContent = scan.code || "(no code)";
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = scan.url;
    const meta = document.createElement("div");
    meta.className = "meta";
    const parts = [formatTime(scan.timestamp)];
    if (scan.note) parts.push(`note: ${scan.note}`);
    parts.push(scan.status);
    meta.textContent = parts.join(" · ");
    els.lastScan.append(code, url, meta);
    els.lastScan.classList.remove("flash");
    // force reflow so animation restarts
    void els.lastScan.offsetWidth;
    els.lastScan.classList.add("flash");
  }

  async function renderHistory() {
    const all = await getAllScans();
    all.sort((a, b) => b.timestamp - a.timestamp);
    els.history.innerHTML = "";
    els.historyEmpty.hidden = all.length > 0;
    for (const scan of all) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = `history-status ${scan.status}`;
      dot.title = scan.status;
      const body = document.createElement("div");
      body.className = "history-body";
      const code = document.createElement("div");
      code.className = "history-code";
      code.textContent = scan.code || "(no code)";
      const url = document.createElement("div");
      url.className = "history-url";
      url.textContent = scan.url;
      const meta = document.createElement("div");
      meta.className = "history-meta";
      const tspan = document.createElement("span");
      tspan.textContent = formatTime(scan.timestamp);
      meta.append(tspan);
      if (scan.note) {
        const nspan = document.createElement("span");
        nspan.textContent = `note: ${scan.note}`;
        meta.append(nspan);
      }
      const sspan = document.createElement("span");
      sspan.textContent = scan.status;
      meta.append(sspan);
      body.append(code, url, meta);
      li.append(dot, body);
      els.history.append(li);
    }
  }

  // ---------- Scanner ----------

  let scanner = null;
  let lastDecoded = { value: null, at: 0 };

  function errorText(err) {
    if (!err) return "";
    if (typeof err === "string") return err;
    return err.message || err.name || String(err);
  }

  // Phones with multiple back cameras (Pixel, Samsung, iPhone) expose all of
  // them with facingMode=environment. The browser frequently picks the wrong
  // one — on Samsung the default lands on a depth/macro/telephoto sensor that
  // doesn't even support autofocus.
  //
  // Heuristic: enumerate, drop front + obvious aux lenses (ultra-wide / tele /
  // depth / macro), then prefer the *lowest* "camera N" number — on Android
  // this is conventionally the main lens. iPhone labels lack numbers, so it
  // falls back to enumeration order, which is fine there.
  async function pickBackCamera() {
    try {
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || !cameras.length) return null;
      const isBack = (c) =>
        !c.label || /back|environment|rear/i.test(c.label);
      const isAux = (c) =>
        /ultra.?wide|wide.?angle|telephoto|^wide|\b0\.\d+x?\b|\bx?\d+x\b|depth|macro/i.test(c.label);
      const cameraNum = (c) => {
        const m = (c.label || "").match(/camera\s+(\d+)/i);
        return m ? parseInt(m[1], 10) : 999;
      };
      const back = cameras.filter(isBack);
      const pool = back.length ? back : cameras;
      const main = pool
        .filter((c) => !isAux(c))
        .sort((a, b) => cameraNum(a) - cameraNum(b))[0] || pool[0];
      return { id: main.id, label: main.label || "(unlabeled)" };
    } catch (err) {
      console.warn("pickBackCamera failed:", err);
      return null;
    }
  }

  async function applyTrackConstraints() {
    try {
      const video = document.querySelector("#reader video");
      if (!video || !video.srcObject) return;
      const track = video.srcObject.getVideoTracks()[0];
      if (!track) return;
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const advanced = [];
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        advanced.push({ focusMode: "continuous" });
      }
      // Force 1x zoom — defeats software ultra-wide on some Androids
      if (caps.zoom && typeof caps.zoom.min === "number" && caps.zoom.min <= 1) {
        advanced.push({ zoom: 1 });
      }
      if (advanced.length) {
        await track.applyConstraints({ advanced });
      }
      console.log("Camera caps:", caps, "applied:", advanced);
    } catch (err) {
      console.warn("applyTrackConstraints failed:", err);
    }
  }

  async function startScanner() {
    if (scanner) return;
    if (typeof Html5Qrcode === "undefined") {
      toast("Scanner library failed to load");
      return;
    }
    scanner = new Html5Qrcode("reader", { verbose: false });

    const cam = await pickBackCamera();
    const cameraSelector = cam
      ? { deviceId: { exact: cam.id } }
      : { facingMode: "environment" };

    // videoConstraints (when set) override the first-arg camera selection.
    // We use them to request high-res + autofocus alongside the chosen device.
    const videoConstraints = {
      ...(cam
        ? { deviceId: { exact: cam.id } }
        : { facingMode: "environment" }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: "continuous" }],
    };

    const scanConfig = {
      fps: 30,
      qrbox: { width: 280, height: 280 },
      aspectRatio: 1.7777778, // 16:9 — most phone cameras' native ratio
      disableFlip: true,      // QR codes never need mirror-decode → faster
      videoConstraints,
      // Native BarcodeDetector when available (Android Chrome) — orders of
      // magnitude faster than the jsQR fallback.
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    };
    if (typeof Html5QrcodeSupportedFormats !== "undefined") {
      scanConfig.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
    }

    try {
      await scanner.start(cameraSelector, scanConfig, onDecoded, () => {});
      applyTrackConstraints();
      if (cam) console.log("Camera selected:", cam.label, cam.id);
      els.startBtn.hidden = true;
      els.stopBtn.hidden = false;
    } catch (err) {
      const msg = errorText(err);
      console.error("Camera start failed:", err, "—", msg);
      let toastMsg;
      if (/notallowed|permission|denied/i.test(msg)) {
        toastMsg = "Camera blocked — allow it in site permissions and reload";
      } else if (/notfound|no.*camera/i.test(msg)) {
        toastMsg = "No camera found on this device";
      } else if (/notreadable|in use/i.test(msg)) {
        toastMsg = "Camera is in use by another app";
      } else if (/overconstrained|constraint/i.test(msg)) {
        toastMsg = "Camera doesn't support the requested settings";
      } else if (/insecure|https/i.test(msg)) {
        toastMsg = "Camera needs HTTPS — open the GitHub Pages URL, not localhost";
      } else {
        toastMsg = "Camera error: " + (msg.slice(0, 80) || "unknown");
      }
      toast(toastMsg);
      try { await scanner.clear(); } catch (_) {}
      scanner = null;
    }
  }

  async function stopScanner() {
    if (!scanner) return;
    try {
      await scanner.stop();
      await scanner.clear();
    } catch (err) {
      console.warn("Scanner stop error:", err);
    }
    scanner = null;
    els.startBtn.hidden = false;
    els.stopBtn.hidden = true;
  }

  async function onDecoded(text) {
    const now = Date.now();
    if (text === lastDecoded.value && now - lastDecoded.at < REPEAT_WINDOW_MS) {
      return; // rapid repeat — silently skip
    }
    lastDecoded = { value: text, at: now };

    const scan = {
      id: uuid(),
      url: text,
      code: extractCode(text),
      timestamp: now,
      note: els.noteInput.value.trim() || "",
      status: "pending",
    };
    await putScan(scan);
    renderLastScan(scan);
    renderHistory();
    flashSuccess();
    vibrate(60);

    // try to sync immediately; if offline, it'll wait
    syncPending();
  }

  // ---------- Sync ----------

  let syncing = false;

  async function syncPending() {
    if (syncing) return;
    if (!navigator.onLine) return;
    if (!window.CONFIG || !CONFIG.endpoint || CONFIG.endpoint.includes("PASTE_DEPLOYMENT_ID")) {
      // config not set yet — nothing to do
      return;
    }
    syncing = true;
    try {
      const pending = await getPendingScans();
      if (pending.length === 0) return;
      let synced = 0, failed = 0;
      for (const scan of pending) {
        const ok = await postScan(scan);
        if (ok) {
          scan.status = "synced";
          await putScan(scan);
          synced++;
        } else {
          failed++;
        }
      }
      await renderHistory();
      if (synced && !failed) toast(`Synced ${synced} scan${synced > 1 ? "s" : ""}`);
      if (failed) toast(`${failed} scan${failed > 1 ? "s" : ""} failed to sync`);
    } finally {
      syncing = false;
    }
  }

  async function postScan(scan) {
    try {
      const res = await fetch(CONFIG.endpoint, {
        method: "POST",
        // text/plain dodges the CORS preflight that Apps Script handles poorly
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({
          secret: CONFIG.secret,
          scan: {
            id: scan.id,
            url: scan.url,
            code: scan.code || extractCode(scan.url),
            timestamp: scan.timestamp,
            note: scan.note || "",
          },
        }),
        redirect: "follow",
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return !!(data && data.ok);
    } catch (err) {
      console.warn("Sync POST failed:", err);
      return false;
    }
  }

  // ---------- Wiring ----------

  els.startBtn.addEventListener("click", startScanner);
  els.stopBtn.addEventListener("click", stopScanner);
  els.syncBtn.addEventListener("click", () => {
    if (!navigator.onLine) { toast("You're offline — will sync when back online"); return; }
    syncPending();
  });

  window.addEventListener("online", () => { renderConnection(); syncPending(); });
  window.addEventListener("offline", renderConnection);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncPending();
  });

  // Init
  renderConnection();
  renderHistory();
  syncPending();
})();
