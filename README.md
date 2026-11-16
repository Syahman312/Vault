# Vault

A private vault for personal documents (IC, passport, licence, insurance, road tax, warranties, ACCA, payslips, tax, property, medical, wedding).
It's a single-file PWA on GitHub Pages, backed by your own Google Apps Script bridge, with a Google Sheet as the index, Google Drive for the files and Google Calendar for renewal reminders.

- **Find anything fast**: search, categories, owners, tags, list or grid
- **Never miss an expiry**: Expiring tab, home banner, app badge, calendar events at *expiry − lead days* and on the expiry date
- **Filed automatically**: `Vault/<Category>/<Year>/YYYY-MM-DD_<Category>_<Title>_<Owner>.ext`
- **Scan**: camera, auto-crop, ≤ 1.5 MB JPEGs, multi-page PDF
- **Renew flow**: new version + archived previous version, reminders moved
- **Locked down**: 6-digit PIN + Face ID / fingerprint, masked numbers, optional AES-GCM encryption, 24 h share links
- **Linked**: Garage, Ledger (read-only references), Flow (renewal tasks)
- **Backups**: daily JSON in Drive, export/import, 14 device snapshots, 30-day trash

## Files
| Path | What |
|---|---|
| `index.html` | The whole app |
| `sw.js`, `manifest.json`, `icons/`, `favicon.svg` | PWA shell |
| `404.html`, `robots.txt`, `.nojekyll` | GitHub Pages plumbing (site is `noindex`) |
| `apps-script/Code.gs`, `apps-script/appsscript.json` | The bridge |
| `SETUP.md` | Step-by-step install |

Start with **[SETUP.md](SETUP.md)**.
