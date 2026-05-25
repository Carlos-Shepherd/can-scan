/**
 * Can Scan — Google Apps Script web app endpoint.
 *
 * Setup (see the project's qr-scanner-pwa-build-plan.md for full context):
 *   1. Create a Google Sheet. Row 1 headers (in this order):
 *        A: URL    B: Code    C: Timestamp    D: Note    E: Scan ID
 *      Copy the sheet's ID from its URL: the long string between /d/ and /edit.
 *   2. Paste that ID into SHEET_ID below. If you renamed the tab from "Sheet1",
 *      update SHEET_NAME too.
 *   3. Replace SECRET with a long random string. Put the SAME string into
 *      config.js in the PWA.
 *   4. Save (disk icon). Deploy → New deployment → Web app:
 *        - Execute as: Me
 *        - Who has access: Anyone (SECRET is what actually gates writes)
 *      The first deploy will prompt you to authorize the script — accept.
 *      Copy the resulting /exec URL into config.js as `endpoint`.
 *   5. Any time you edit this script, click Deploy → Manage deployments →
 *      pencil icon → Version: New version → Deploy. The /exec URL stays the same.
 */

const SHEET_ID = "1--33LaLoAx_ewJMRUwzQbRi8ihAARlGpjhmRZlr7DsM";          // from the Sheet's URL
const SHEET_NAME = "Sheet1";                          // tab name within the sheet
const SECRET = "awilreunvasioev789349vnoijk6n98";   // must match config.js

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (err) {
      return json({ ok: false, error: "invalid json" });
    }

    if (!payload || payload.secret !== SECRET) {
      return json({ ok: false, error: "unauthorized" });
    }

    const scan = payload.scan;
    if (!scan || !scan.id || !scan.url || !scan.timestamp) {
      return json({ ok: false, error: "missing fields" });
    }

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) {
      return json({ ok: false, error: "sheet tab not found: " + SHEET_NAME });
    }

    // Idempotency: skip if this scan ID has already been written.
    // Column E (index 5) = Scan ID; rows start at 2 (row 1 is the header).
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const existingIds = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
      for (let i = 0; i < existingIds.length; i++) {
        if (existingIds[i][0] === scan.id) {
          return json({ ok: true, duplicate: true });
        }
      }
    }

    sheet.appendRow([
      scan.url,
      scan.code || "",
      new Date(scan.timestamp),
      scan.note || "",
      scan.id,
    ]);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// GET handler — useful for quickly confirming the deployment is live.
function doGet() {
  return json({ ok: true, service: "can-scan", time: new Date().toISOString() });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
