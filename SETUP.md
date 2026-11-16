# Vault — setup guide

Vault has three parts, all in your own accounts:

```
iPhone / iPad / Poco / PC  (PWA on GitHub Pages)
        │ HTTPS POST, app key in the body
        ▼
Apps Script "Vault bridge" (your Google account)
        ├── Sheet  "Vault Data"         index: Documents, Categories, People, Reminders, Shares, _Log, _Deleted
        ├── Drive  Vault/<Category>/<Year>/   the files
        ├── Drive  Vault/Backups/        daily JSON (last 30)
        ├── Drive  Vault/_Trash/         deleted files, purged after 30 days
        └── Calendar "Vault"             expiry + renewal reminders
```

Allow about 15 minutes. Do the steps in order.

---

## 1. Bridge (Apps Script)

1. Go to **script.google.com** → **New project**. Rename it **Vault bridge**.
2. Delete the sample code in `Code.gs` and paste the whole of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Click **Project Settings** (gear) → tick **Show "appsscript.json" manifest file in editor**.
   Back in the editor, open `appsscript.json` and replace it with [`apps-script/appsscript.json`](apps-script/appsscript.json).
   This sets the time zone to **Asia/Kuala_Lumpur** and limits access to Drive, Sheets, Calendar and triggers.
4. Pick **`setup`** in the function dropdown → **Run**.
   - Google asks for permission → choose your account → *Advanced* → *Go to Vault bridge (unsafe)* → **Allow**.
     ("Unsafe" only means you wrote the script yourself and Google has not reviewed it.)
   - Open **Execution log**. Copy both keys somewhere safe (a password manager):
     - **APP KEY** (48 characters): what your devices use. Full access.
     - **LINK KEY** (32 characters): read-only, for Garage / Ledger / Flow.
   - `setup` also creates the Sheet, the Drive folders, the "Vault" calendar and three triggers
     (daily 03:00 job, hourly share revoker, Sheet onEdit). It is safe to run again; it only adds what is missing and never changes the key.
5. **Deploy** → **New deployment** → type **Web app**
   - Description: `Vault bridge`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy** → copy the **Web app URL** (ends in `/exec`).

> **Why "Anyone"?** The app on your phone is not signed in to Google, so the URL has to be reachable.
> Every request still needs the 48-character app key. The key is checked by SHA-256 compare, there is a rate limit,
> and after **10 wrong keys the bridge locks itself** until you run `unlock` in the editor.

### Updating the bridge later
Paste the new code → **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
The URL stays the same. (Do *not* use "New deployment", which gives you a new URL.)

### Editor functions
| Function | Use it when |
|---|---|
| `setup` | First time, or **Run checks** says a tab, folder or trigger is missing |
| `rotateKey` | You lost the app key or think it leaked. Prints a new one; the old one stops working at once |
| `rotateLinkKey` | A linked app's key leaked |
| `unlock` | The bridge locked after 10 wrong keys (run `rotateKey` too if that wasn't you) |
| `dailyJob` / `hourlyJob` | Run by hand to test backups, trash purge, share revoke |

---

## 2. GitHub Pages

1. In this repo: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
2. After about a minute the app is live at `https://syahman312.github.io/<repo-name>/`.
   - If you want the address to be `…/vault/`, rename the repo to `vault` (**Settings → General → Repository name**).
     The app uses relative paths only, so either name works.
3. The site is `noindex` (meta tag + `robots.txt` disallows everything) and has no sitemap.

Updating the app = push to `main`. Installed apps pick up the new version on their next launch (the service worker fetches `index.html` network-first).

---

## 3. Install on each device

Open the Pages URL, then:

| Device | How |
|---|---|
| **iPhone / iPad** | Safari → Share → **Add to Home Screen** → open Vault from the home screen |
| **Poco / Android** | Chrome → ⋮ → **Install app** (or *Add to Home screen*) |
| **PC** | Chrome / Edge → install icon in the address bar (or ⋮ → *Install Vault*) |

On first open:
1. Paste the **Web app URL** and the **APP KEY** → **Connect**.
2. Create a **6-digit PIN** (asked on every open and after 5 min idle; change it in Settings).
3. Say **yes** to Face ID / fingerprint if offered.

**What each device gets:**
- **iPhone / Android phone**: bottom tab bar, camera scanning, Face ID / fingerprint. The tab bar hides while you type, and fields are sized so iOS doesn't zoom in. Landscape works too.
- **iPad / Android tablet**: wider cards in portrait. In landscape you get a side bar, the file preview next to the details, and a two-column Add form.
- **PC**: side bar and two-column layouts. **Drag files** onto the window or **paste** an image (Ctrl/⌘+V) to add them. Keyboard: `/` search · `n` add · `b` browse · `e` expiring · `s` settings · `Esc` back.

Each device keeps its own PIN. Forgot it? Tap **Forgot PIN?** and enter the app key to set a new one.

---

## 4. Run checks

**Settings → Run checks**. Everything should be ✓:

- This device: bridge URL format, online, IndexedDB, Web Crypto, service worker, persistent storage, PIN, pending uploads
- Bridge: reachable + key valid (with response time)
- Server: Sheet opens, all tabs present, Drive root, category folders, "Vault" calendar, triggers, backup within 48 h, expired shares revoked, failed key attempts

A fresh install shows **Backup in last 48 h ✗** until the first nightly run. Tap **Settings → Backup now** to clear it.

Then try it end to end: **Add → File** → pick a PDF → set an expiry 10 days out → **Save to Drive**.
Check that the file appears under `Drive › Vault/<Category>/<Year>/` with the new name, and that two events appear in the **Vault** calendar.

---

## 5. Optional extras

### Client-side encryption (Identity)
**Settings → Security → Encryption passphrase.** Files in encrypted documents (and their document number)
are encrypted with **AES-GCM**, using a key derived from your passphrase (**PBKDF2-SHA-256, 310,000 rounds**), *before* upload.
Drive only stores `….enc` ciphertext, and only a random salt plus a check value are kept on the server.

⚠️ **Lose the passphrase and those files are gone for good.** No reset is possible. Write it down outside Vault.

- Identity defaults to *optional per document* (toggle on the Add screen). Change it per category in Settings → Categories (Off / Optional / Always).
- Encrypted files can't be shared by Drive link; use **Share → Send file from this device**.
- The passphrase key lives only in memory and is forgotten when the app locks.

### Linked apps (Garage, Ledger, Flow)
**Settings → Linked apps.** For each app enter its bridge URL, its key and (optionally) its app page URL for ↗ links.
Vault calls the other bridge **directly from your device** (always a `script.google.com` URL), so Vault's Apps Script needs no extra permission.

The shared contract:

```js
// request (POST, text/plain JSON)
{ "action": "list", "key": "<that app's key>" }
// response
{ "ok": true, "items": [ { "id": "...", "title": "...", "date": "YYYY-MM-DD", "amount": 12.5, "driveId": "<optional Drive file id>" } ] }
```
Vault also understands `ID / carId / txnId / taskId`, `name / description / merchant / plate`, and `fileId / receiptId`.

- **Garage**: on the Add screen set *Linked app = Garage* → **Pick** a car. To let Garage read road-tax and insurance expiry,
  give Garage Vault's URL plus the **link key** and call
  `{ "action": "list", "key": "<link key>", "filter": { "linkedApp": "garage", "linkedId": "<carId>" } }`.
  This returns title, category, issue and expiry dates and status, but **never document numbers or files**.
- **Ledger**: **Settings → Import from Ledger** lists Ledger items that have a Drive file. Imported docs store only the Drive ID
  (`ref: true`). Vault never moves, renames or deletes them; they are **read-only references**.
- **Flow**: turn on **Create renewal tasks**. When a doc gets or changes an expiry date, Vault sends
  `{ "action": "add", "key": "<Flow key>", "task": { "title": "🔐 Renew: …", "text": "🔐 Renew: … #personal !high", "due": "YYYY-MM-DD", … } }`.
  If Flow's create action has a different name, change `FLOW_ADD_ACTION` near the top of section 15 in `index.html`.

Deep links go both ways: calendar events and Flow tasks contain `…/#doc=<ID>`, and Vault opens `<page>#car=<id>`, `#txn=<id>` or `#task=<id>` in the other apps.

---

## 6. Backup & recovery

| Layer | Where | How to restore |
|---|---|---|
| Sheet (master) | Drive › Vault › "Vault Data" | Google Sheets version history |
| Daily JSON | Drive › Vault/Backups (last 30) | Download it → Settings → **Import JSON** |
| Manual export | Settings → **Export JSON** | Settings → **Import JSON** |
| Device snapshots | This device (last 14 days) | Settings → **Device snapshots → Restore** |
| Files | Drive itself (backups store Drive IDs) | Drive trash / version history |
| Deleted docs | Drive › Vault/_Trash for 30 days | Settings → **Trash → Restore** |

Import merges: rows with a newer `Updated` win, and a safety backup is taken first.

---

## 7. Security notes (what this protects, honestly)

- **The app key is the real secret.** It lives in the browser storage of each installed device. Anyone with the key *and* the URL can use the bridge. Rotate it if a device is lost.
- **PIN and Face ID are a screen lock**, not encryption. They stop someone picking up your unlocked phone. WebAuthn is checked on the device only.
- The app blurs when switched away from (app-switcher snapshot), never caches bridge responses in the service worker, and keeps opened files only in memory unless you turn on *Keep opened files on this device*.
- Document numbers are masked (first character plus last 4). Press and hold, or use 👁, to reveal for 15 s. **Copy** clears the clipboard after 60 s (best effort; iOS may block the clear if the app is in the background).
- **Share links** make one Drive file "anyone with the link can view". They are logged in `_Log` and the `Shares` tab, and the hourly trigger revokes them after 24 h. You can also revoke from Settings → Active share links.
- CSP allows network requests only to `script.google.com` / `script.googleusercontent.com` (where Apps Script redirects its responses). No fonts, CDNs or analytics.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Bridge returned non-JSON" | Deployment access isn't **Anyone**, or you used the editor's test URL instead of `/exec` |
| "Wrong app key" | Re-paste the key. Ten wrong tries locks the bridge → run `unlock` |
| "Run setup() first" | You deployed before running `setup` |
| Upload stalls | Files over 4 MB upload in 3 MB chunks; a weak signal retries automatically. The limit is 20 MB per file |
| No calendar events | Run checks → Calendar ✓? Then Settings → **Rebuild calendar reminders** |
| Changes made in the Sheet don't show | The onEdit trigger bumps `Updated`; pull to sync (tap the dot top-right). Run checks shows whether the trigger exists |
| "Changes waiting" never clears | Settings → Run checks shows the first pending item's error |

---

## Notes on the build

- **Scan → PDF** uses a ~40-line built-in JPEG-to-PDF writer instead of jsPDF. Same result, no library or CDN, about 350 KB smaller.
- **Auto-crop** finds the document against a plain, contrasting background and trims it. It doesn't de-skew; use ↻ to rotate. Each page is compressed to a JPEG of at most 1.5 MB.
- **Preview** downloads the file through the bridge and shows it from a local blob. This avoids Drive iframes, which would need a Google sign-in and a request to `drive.google.com`.
- Tested with a mock bridge at 320 / 393 / 412 / 820 / 1280 px. No horizontal overflow, no requests outside `script.google.com`.
