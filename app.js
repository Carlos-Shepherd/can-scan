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
  const HISTORY_RENDER_LIMIT = 100; // newest N shown in UI (all still synced)

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
    testBtn: document.getElementById("test-btn"),
    syncBtn: document.getElementById("sync-btn"),
    noteInput: document.getElementById("note-input"),
    lastScanSection: document.getElementById("last-scan-section"),
    lastScan: document.getElementById("last-scan"),
    history: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    historyCount: document.getElementById("history-count"),
    connection: document.getElementById("connection-status"),
    toast: document.getElementById("toast"),
    flash: document.getElementById("scan-flash"),
  };

  // ---------- Status (live diagnostics bar) ----------
  //
  // Exists to answer "why is the QR taking so long to scan." Tracks decode-loop
  // frames-per-second, time since last successful scan, skipped-UPC count, and
  // sync queue depth. The expandable panel exposes a rolling event log so a
  // 7-second delay can be inspected after the fact.
  const Status = (() => {
    const MAX_EVENTS = 50;
    const SLOW_MS = 5000;

    const s = {
      mode: "idle", // idle | scanning | error
      framesInWindow: 0,
      windowStart: Date.now(),
      fps: 0,
      lastScanAt: null,
      skipped: 0,
      pending: 0,
      cameraInfo: null,
      events: [],
      // Decoder telemetry — reset each time the camera starts
      sessionStart: null,    // ms epoch when camera started
      totalAttempts: 0,      // frames examined (success + failure)
      totalDecodes: 0,       // raw decoder hits (before our UPC/dedupe filters)
    };

    const e = {};
    let initialized = false;

    function init() {
      if (initialized) return;
      initialized = true;
      e.bar      = document.getElementById("status");
      e.dot      = e.bar.querySelector(".state-dot");
      e.state    = document.getElementById("status-state");
      e.fps      = document.getElementById("status-fps");
      e.since    = document.getElementById("status-since");
      e.skipped  = document.getElementById("status-skipped");
      e.pending  = document.getElementById("status-pending");
      e.panel    = document.getElementById("status-panel");
      e.camera   = document.getElementById("status-camera");
      e.decoder  = document.getElementById("status-decoder");
      e.log      = document.getElementById("status-log");

      e.bar.addEventListener("click", toggle);
      e.bar.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
      });

      setInterval(tickBar, 200);
      setInterval(tickFps, 1000);
    }

    function toggle() {
      const opening = e.panel.hidden;
      e.panel.hidden = !opening;
      e.bar.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) renderPanel();
    }

    function pushEvent(kind, msg) {
      s.events.push({ at: Date.now(), kind, msg });
      if (s.events.length > MAX_EVENTS) s.events.shift();
      if (!e.panel.hidden) renderPanel();
    }

    function tickFps() {
      const now = Date.now();
      const elapsed = (now - s.windowStart) / 1000;
      s.fps = elapsed > 0 ? s.framesInWindow / elapsed : 0;
      s.framesInWindow = 0;
      s.windowStart = now;
    }

    function tickBar() {
      if (!initialized) return;
      const sinceMs = s.lastScanAt ? Date.now() - s.lastScanAt : null;
      const sinceText =
        sinceMs == null ? "—" :
        sinceMs < 1000  ? "just now" :
                          `${(sinceMs / 1000).toFixed(1)}s ago`;

      let displayMode = s.mode;
      if (displayMode === "scanning" && sinceMs != null && sinceMs > SLOW_MS) displayMode = "slow";

      e.dot.dataset.state = displayMode;
      e.state.textContent = s.mode;
      e.fps.textContent   = s.mode === "scanning" ? `${Math.round(s.fps)} fps` : "—";
      e.since.textContent = sinceText;

      e.skipped.hidden = s.skipped === 0;
      e.skipped.textContent = `${s.skipped} skipped`;

      e.pending.hidden = s.pending === 0;
      e.pending.textContent = `${s.pending} pending`;

      if (e.panel && !e.panel.hidden) renderDecoder();
    }

    function renderDecoder() {
      if (!initialized || !e.decoder) return;
      if (s.sessionStart) {
        const elapsed = Math.max(1, Math.round((Date.now() - s.sessionStart) / 1000));
        const rate = (s.totalAttempts / elapsed).toFixed(1);
        e.decoder.textContent =
          `decoder: ${s.totalAttempts} attempts / ${s.totalDecodes} decodes ` +
          `in ${elapsed}s (${rate}/s)`;
      } else {
        e.decoder.textContent = "";
      }
    }

    function renderPanel() {
      if (!initialized) return;
      const c = s.cameraInfo;
      e.camera.textContent = c
        ? `${c.label}  ·  ${c.resolution}  ·  focus: ${c.focusMode || "?"}  ·  zoom: ${c.zoom != null ? c.zoom : "?"}`
        : "(camera not started)";

      renderDecoder();

      const frag = document.createDocumentFragment();
      for (let i = s.events.length - 1; i >= 0; i--) {
        const ev = s.events[i];
        const li = document.createElement("li");
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = new Date(ev.at).toLocaleTimeString([], { hour12: false });
        const m = document.createElement("span");
        m.className = "ev " + (ev.kind || "");
        m.textContent = ev.msg;
        li.append(ts, m);
        frag.append(li);
      }
      e.log.innerHTML = "";
      e.log.append(frag);
    }

    return {
      init,
      frame: () => { s.framesInWindow++; s.totalAttempts++; },
      decoded: () => { s.totalDecodes++; },
      resetSession: () => {
        s.sessionStart = Date.now();
        s.totalAttempts = 0;
        s.totalDecodes = 0;
        if (e.panel && !e.panel.hidden) renderDecoder();
      },
      setMode: (m) => { s.mode = m; if (m === "idle") s.fps = 0; },
      scanned: (code) => { s.lastScanAt = Date.now(); pushEvent("success", "scanned " + code); },
      skippedUpc: (val) => { s.skipped++; pushEvent("warn", "skipped UPC " + val); },
      setPending: (n) => { s.pending = Math.max(0, n | 0); },
      setCameraInfo: (info) => { s.cameraInfo = info; if (e.panel && !e.panel.hidden) renderPanel(); },
      log: (msg) => pushEvent("info", msg),
      warn: (msg) => pushEvent("warn", msg),
      error: (msg) => pushEvent("error", msg),
      success: (msg) => pushEvent("success", msg),
    };
  })();

  Status.init();

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
    const shown = all.slice(0, HISTORY_RENDER_LIMIT);
    els.historyEmpty.hidden = all.length > 0;
    if (els.historyCount) {
      els.historyCount.textContent =
        all.length > HISTORY_RENDER_LIMIT
          ? `${HISTORY_RENDER_LIMIT} of ${all.length}`
          : "";
    }
    const frag = document.createDocumentFragment();
    for (const scan of shown) {
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
      frag.append(li);
    }
    els.history.innerHTML = "";
    els.history.append(frag);
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
      const beforeSettings = track.getSettings ? track.getSettings() : {};
      console.log("Camera caps:", caps, "before:", beforeSettings);
      Status.log(
        `caps: ${caps.width ? caps.width.max + "x" + caps.height.max : "?"} ` +
        `(currently ${beforeSettings.width}x${beforeSettings.height})`
      );

      // Push to the camera's native max resolution. getUserMedia's "ideal"
      // hint was returning 612x1088 on Samsung Galaxy — way too low for a QR
      // that isn't filling the frame. Each QR module needs ~5+ pixels for the
      // decoder to recognize it. applyConstraints on the live track lets us
      // upgrade after we know what the camera can actually do.
      const targetWidth = caps.width && caps.width.max ? caps.width.max : 1920;
      const targetHeight = caps.height && caps.height.max ? caps.height.max : 1080;

      const advanced = [];
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        advanced.push({ focusMode: "continuous" });
      }
      if (caps.zoom && typeof caps.zoom.min === "number" && caps.zoom.min <= 1) {
        advanced.push({ zoom: 1 });
      }

      try {
        await track.applyConstraints({
          width: { ideal: targetWidth },
          height: { ideal: targetHeight },
          advanced,
        });
      } catch (e) {
        // Retry without resolution if the camera refused it
        console.warn("Hi-res applyConstraints failed, retrying without:", e);
        if (advanced.length) await track.applyConstraints({ advanced });
      }

      const afterSettings = track.getSettings ? track.getSettings() : {};
      console.log("Camera applied:", afterSettings);
      const upgraded =
        (afterSettings.width || 0) > (beforeSettings.width || 0) ||
        (afterSettings.height || 0) > (beforeSettings.height || 0);
      if (upgraded) {
        Status.success(
          `resolution upgraded ${beforeSettings.width}x${beforeSettings.height} → ` +
          `${afterSettings.width}x${afterSettings.height}`
        );
      } else if (
        afterSettings.width &&
        targetWidth &&
        afterSettings.width < targetWidth * 0.6
      ) {
        Status.warn(
          `low res: got ${afterSettings.width}x${afterSettings.height}, ` +
          `max is ${targetWidth}x${targetHeight}`
        );
      }
      Status.setCameraInfo({
        label: state_cameraLabel || "(unknown)",
        resolution: `${afterSettings.width || "?"}x${afterSettings.height || "?"}`,
        focusMode: afterSettings.focusMode,
        zoom: afterSettings.zoom,
      });
    } catch (err) {
      console.warn("applyTrackConstraints failed:", err);
      Status.warn("applyTrackConstraints failed: " + (err.message || err));
    }
  }

  let state_cameraLabel = "";

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
      // Scale the scan region with whatever resolution the camera gives us
      // (1920x1080 → 756x756 box). Fixed pixel sizes were way too small when
      // the camera went hi-res, so QRs in clear view fell outside the box.
      qrbox: (vw, vh) => {
        const s = Math.floor(Math.min(vw, vh) * 0.7);
        return { width: s, height: s };
      },
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
      Status.resetSession();
      await scanner.start(cameraSelector, scanConfig, onDecoded, () => Status.frame());
      applyTrackConstraints();
      if (cam) {
        console.log("Camera selected:", cam.label, cam.id);
        state_cameraLabel = cam.label;
      }
      Status.setMode("scanning");
      Status.success("camera started" + (cam ? " (" + cam.label + ")" : ""));
      els.startBtn.hidden = true;
      els.stopBtn.hidden = false;
      if (els.testBtn) els.testBtn.hidden = false;
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
      Status.setMode("error");
      Status.error(toastMsg);
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
    if (els.testBtn) els.testBtn.hidden = true;
    Status.setMode("idle");
    Status.log("camera stopped");
  }

  // Phase-2 diagnostic: snapshot the current frame, throw BarcodeDetector at it
  // with EVERY supported format on the FULL frame (no qrbox crop). Isolates
  // whether the live loop is the bug vs the decoder itself vs framing.
  async function testScan() {
    const video = document.querySelector("#reader video");
    if (!video || !video.videoWidth) {
      Status.warn("test: no live video");
      return;
    }
    if (typeof BarcodeDetector === "undefined") {
      Status.warn("test: BarcodeDetector unavailable in this browser");
      return;
    }
    Status.log("test: capturing frame…");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);

      const allFormats = await BarcodeDetector.getSupportedFormats();
      const detector = new BarcodeDetector({ formats: allFormats });
      const t0 = performance.now();
      const codes = await detector.detect(canvas);
      const dt = Math.round(performance.now() - t0);

      if (codes.length === 0) {
        Status.warn(
          `test: 0 codes in ${canvas.width}x${canvas.height} (${dt}ms, ` +
          `tried: ${allFormats.join(", ")})`
        );
      } else {
        for (const c of codes) {
          Status.success(`test: ${c.format} = ${c.rawValue.slice(0, 80)}`);
        }
        Status.log(`test: ${codes.length} found in ${dt}ms`);
      }
    } catch (e) {
      Status.error("test: " + (e.message || e));
    }
  }

  async function onDecoded(text) {
    const now = Date.now();
    Status.frame();
    Status.decoded(); // raw decoder hit, before any filtering

    // Cans carry both a UPC barcode and the URL-bearing QR. Native
    // BarcodeDetector decodes either. UPC-A/EAN are purely numeric, 8–14
    // digits — silently skip them so the decoder keeps hunting for the QR
    // without interrupting the user.
    if (/^\d{8,14}$/.test(text)) {
      Status.skippedUpc(text);
      return;
    }

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
    pendingCount++;
    Status.setPending(pendingCount);
    Status.scanned(scan.code || "(no code)");
    renderLastScan(scan);
    renderHistory();
    flashSuccess();
    vibrate(60);

    // try to sync immediately; if offline, it'll wait
    syncPending();
  }

  let pendingCount = 0;

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
      pendingCount = pending.length;
      Status.setPending(pendingCount);
      if (pending.length === 0) return;
      Status.log(`sync start (${pending.length} pending)`);
      let synced = 0, failed = 0;
      for (const scan of pending) {
        const ok = await postScan(scan);
        if (ok) {
          scan.status = "synced";
          await putScan(scan);
          synced++;
          pendingCount = Math.max(0, pendingCount - 1);
          Status.setPending(pendingCount);
          Status.success("synced " + (scan.code || scan.id.slice(0, 8)));
        } else {
          failed++;
          Status.error("sync failed: " + (scan.code || scan.id.slice(0, 8)));
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
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("Sync HTTP", res.status, body.slice(0, 200));
        return false;
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        // Most common cause: deployment URL is stale and Google served the
        // login/redirect HTML page instead of the script response.
        console.warn(
          "Sync non-JSON response (deployment URL stale or auth changed?):",
          text.slice(0, 200)
        );
        return false;
      }
      if (!data.ok) {
        console.warn("Sync rejected by script:", data.error || data);
        return false;
      }
      return true;
    } catch (err) {
      console.warn("Sync POST exception:", err);
      return false;
    }
  }

  // ---------- Wiring ----------

  els.startBtn.addEventListener("click", startScanner);
  els.stopBtn.addEventListener("click", stopScanner);
  if (els.testBtn) els.testBtn.addEventListener("click", testScan);
  els.syncBtn.addEventListener("click", () => {
    if (!navigator.onLine) { toast("You're offline — will sync when back online"); return; }
    syncPending();
  });

  window.addEventListener("online", () => { renderConnection(); syncPending(); });
  window.addEventListener("offline", renderConnection);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Release the camera when the app is backgrounded — keeps the camera
      // indicator light off and saves battery. User taps Start to resume.
      if (scanner) stopScanner();
    } else {
      syncPending();
    }
  });

  // Init
  renderConnection();
  renderHistory();
  (async () => {
    pendingCount = (await getPendingScans()).length;
    Status.setPending(pendingCount);
    syncPending();
  })();
})();
