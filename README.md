# OPT Tracker

An offline-capable Progressive Web App for tracking F-1 **OPT**, **STEM-OPT**, and **CPT** deadlines —
a replacement for the spreadsheet most international students keep by hand.

It is a static site: plain HTML, CSS, and JavaScript. **There is no server and no database anywhere in
this stack**, so the person who publishes it is architecturally incapable of seeing anyone's data.

> **Not legal advice.** This is an unofficial calculator. Immigration rules change and individual cases
> vary. Confirm every date with your DSO / international student office before you file anything.

---

## What it does

| Feature | How it works |
| --- | --- |
| **Three tabs — OPT, STEM-OPT, CPT** | You enter dates; deadlines are computed in JavaScript on your device and color-coded **upcoming** (green) / **within 14 days** (amber) / **passed** (grey). |
| **Fill from a document** | Photograph, screenshot, or open a PDF of your **I-94 printout** or **I-797C receipt notice**. The text is read on your device and the date is offered back to you to confirm. See [below](#fill-from-a-document-on-device). |
| **Installable PWA** | `manifest.json` plus a service worker that caches the app shell. After the first load it opens and works with no connection at all. |
| **Local persistence** | Everything is saved to `localStorage` under the site's own origin. It survives browser restarts and is private to that device and browser profile. |
| **Calendar export** | Builds an `.ics` file in memory with one `VEVENT` per deadline, each carrying two `VALARM`s: **14 days before** and **on the day**. Import it once and your calendar app handles every future notification natively, offline, forever. |
| **Optional Google Drive backup** | Your browser talks **directly to Google** using your own OAuth login and the narrow `drive.file` scope. Nothing passes through any server belonging to this project — there isn't one. |
| **Glossary and official resources** | Definitions and links to USCIS, DHS Study in the States, CBP I-94, ICE SEVP, and E-Verify. |
| **JSON backup / restore** | Download your data as a plain file, or restore it on another device. |

---

## The privacy claim, stated precisely

- The deployed app is a handful of static files, icons, and the document reader's libraries in
  `vendor/`. Open the network tab: every request goes to this site's own origin unless you click the
  Google Drive button.
- There is **no analytics, no telemetry, no error reporting, no fonts or scripts from a CDN**.
- `localStorage` is bound to the origin and never leaves the browser.
- The `.ics` file is generated client-side with `Blob` + `URL.createObjectURL` and handed to your
  browser's download manager. No upload step exists.
- **Documents you scan are never uploaded.** The OCR engine (Tesseract.js, WebAssembly) and PDF reader
  (pdf.js) are served from this site and run inside your browser. The photo or PDF is read into memory,
  its pixels are dropped when the dialog closes, and nothing is stored except the dates you confirm.
- The Google Drive feature uses **Google Identity Services** in the browser. The access token lives in a
  JavaScript variable in memory only, is never written to storage, and is discarded when you close the
  tab. The `drive.file` scope grants access **only to files this app itself created** — it cannot read
  the rest of your Drive.
- The service worker caches this origin's own files only and passes every off-origin request (Google)
  straight through without touching it.

If you want to verify all of that, `app.js`, `scan-ui.js`, and `sw.js` are short and commented, and every
network call in them is greppable: `fetch(`, `import(`, and `script.src`.

---

## Fill from a document (on-device)

Both the OPT and STEM-OPT tabs have a **Scan a document** button. It accepts a camera photo, a
screenshot, or a PDF.

| Document | What it reads | Where it goes |
| --- | --- | --- |
| **I-94 printout** from i94.cbp.dhs.gov (PDF, screenshot, or photo of the printout) | **Admit Until Date**, in either `MM/DD/YYYY` or `YYYY Month DD` form | I-94 expiration date |
| **I-797C receipt notice** for Form **I-765** | **Received Date** (`Month DD, YYYY` or `MM/DD/YYYY`) | I-765 filed / receipt date |

### How it avoids wrong dates

A wrong deadline is worse than a blank one, so the reader is built to leave a field empty rather than
guess:

- **Label-anchored.** A date is only taken from beside or beneath its own printed label. It never takes
  "the first date on the page", so the birth date, entry date, and notice date cannot be picked up by
  mistake.
- **Read twice.** Each date is read once as part of the whole page, then again on its own with different
  image processing. If the two readings disagree, the user is shown both and must choose.
- **No guessing on unclear months.** OCR often confuses letters in month names (`Man` could be March or
  May). When that happens the user picks from the possibilities instead of getting a silent guess.
- **Checks the document.** A receipt for any form other than I-765 (for example an I-539 or I-140) is
  refused. An I-94 that says `D/S` is reported as having no fixed date.
- **Sanity checks.** An admit-until date that is not after the entry date, or a received date later than
  the notice date or in the future, is flagged.
- **The user confirms.** Every result is shown next to a crop of the part of the document it came from,
  and nothing is written into the form until the user ticks **This matches my document**.

### Download size and offline use

The first scan downloads the reader from this site: one engine build (about 3.9 MB, chosen for the
device's CPU), English text data (2.9 MB), and, only for PDFs, pdf.js (1.8 MB). The service worker keeps
them in a separate cache, so later scans work offline and app updates don't re-download them. If a user
has never scanned while online, scanning offline shows a message asking them to connect once.

### Accuracy testing

`tests/fixtures/make_fixtures.py` generates fake I-94 printouts and I-797C notices (invented names,
numbers, and dates) laid out like the real documents, in seven conditions each: clean, low resolution,
fax-style noise, phone photo with shadow and blur, the same photo turned sideways, perspective skew,
and dim low-contrast JPEG. It also generates digital and scanned PDFs, an I-539 receipt that must be
refused, and an unrelated invoice with look-alike labels that must be ignored.

```bash
npm install
npm run fixtures      # needs Python 3 with Pillow
npm run test:scan     # Node: grades every image fixture
```

`tests/scan-harness.html` runs the same fixtures, PDFs included, through the real browser code when the
project is served locally. Both harnesses fail if any wrong date is ever offered as reliable.

It has also been checked against two public sample documents (a scanned I-94 printout and a redacted
I-797C). It has **not** been tested on a wide range of real users' paperwork, which is why every date
must be confirmed by the user.

It does not yet read EAD cards or I-20s, and it cannot read handwriting.

---

## Deploy on GitHub Pages (free)

1. **Create the repo and push these files.**

   ```bash
   git init
   git add .
   git commit -m "OPT Tracker: offline F-1 deadline PWA"
   git branch -M main
   git remote add origin https://github.com/<your-username>/opt-tracker.git
   git push -u origin main
   ```

2. **Turn on Pages.** In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, branch `main`, folder `/ (root)`. Save.

3. Wait about a minute, then open `https://<your-username>.github.io/opt-tracker/`.

   GitHub Pages serves over HTTPS, which is required for service workers — so the PWA and offline mode
   work as soon as it is live. (Locally, `http://localhost` also counts as a secure origin.)

4. **Install it.** On Android/desktop Chrome an "Install app" button appears in the header. On iOS
   Safari, use **Share → Add to Home Screen**.

The included `.nojekyll` file tells Pages to serve the folder as-is rather than running Jekyll over it.

### Running it locally

Serve the folder over HTTP (the service worker, PDF reader, and OCR engine all need a real origin):

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

### Updating a deployed copy

Bump `CACHE` in `sw.js` (for example `opt-tracker-v2` → `opt-tracker-v3`) whenever you change the app.
The old cache is deleted on activation and users get the new version on their next visit.

The reader libraries live in a separate `VENDOR_CACHE`. Leave it alone unless you change the files in
`vendor/` (`npm run vendor` regenerates them from `node_modules`); then bump it too.

---

## Optional: enable the Google Drive backup button

This is the only feature that needs any setup, and the app is fully usable without it. If you skip this,
the Drive button simply reports that no Client ID is configured; users can still paste their own.

**Cost: none.** The Google Cloud project, the OAuth client, and the Drive API at this scope and volume
are free, and no billing account is required.

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and create a project
   (e.g. `opt-tracker`).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in the app name, your support email, and developer contact email.
   - **Scopes** → Add → search for `drive.file` and select
     `https://www.googleapis.com/auth/drive.file` ("See, edit, create, and delete only the specific
     Google Drive files you use with this app"). Add nothing else — this narrow scope is what keeps the
     privacy promise true, and it does **not** require Google's security assessment.
   - While the app is in **Testing**, add each user's Google address under **Test users**. To let anyone
     use it, **Publish app**. With only the `drive.file` scope, publishing does not require a full
     verification review, though Google may still show an unverified-app notice.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: add `https://<your-username>.github.io` (and
     `http://localhost:8000` if you test locally). Origins only — no paths.
   - You do **not** need an authorized redirect URI; the token flow used here is popup-based.
   - Leave the **client secret** alone. This app never uses one, because a client secret would require a
     server to keep it in, and there is no server.
5. Copy the Client ID (it looks like `123456789-abc123.apps.googleusercontent.com`) and either:
   - paste it into `config.js` as `googleClientId`, so everyone using your deployment gets the button; or
   - leave `config.js` blank and let each user paste their own in the **Data & Backup** tab.

An OAuth **Client ID is a public identifier**, not a secret — it appears in the page source of every web
app that uses Google sign-in and is safe to commit.

### What Drive backup actually does

- Click **Save backup to my Drive** → Google's own popup asks you to sign in and consent → your browser
  `POST`s a JSON file named `opt-tracker-backup.json` straight to `googleapis.com`.
- Subsequent backups `PATCH` that same file so your Drive does not fill with copies.
- **Restore latest from Drive** lists files named `opt-tracker-backup.json` (with `drive.file`, only the
  ones this app created are even visible to it) and loads the most recent.
- **Sign out** revokes the access token on this device.

---

## Rules encoded in the calculator

These reflect the **Duration of Status final rule (effective mid-September 2026)** and standard practical
training rules. They are implemented in `app.js` and covered by tests in `tests/rules.test.js`.

**I-94**

- Admission now carries a **fixed expiration date** rather than open-ended "D/S". Look yours up at
  [i94.cbp.dhs.gov](https://i94.cbp.dhs.gov/) — after every entry, extension, or status change.
- **I-539 flag:** if your I-94 expiration falls *before* your OPT (or STEM-OPT) filing deadline, the app
  raises a red flag, because you must be in valid status when USCIS receives the application and may need
  Form I-539 to extend or maintain status first.

**Standard post-completion OPT**

- Application window: **90 days before** your program end date through **60 days after** it.
- If a DSO OPT recommendation date is entered: USCIS must receive the I-765 within **30 days** of it; the
  app uses whichever deadline comes first.
- Duration: **12 months** (end date auto-calculated as start + 12 months − 1 day; overridden by the date
  on your EAD once you have it).
- **30-day grace period** after OPT ends.
- 60-day grace period after program completion if no OPT is filed.
- 90 aggregate days of unemployment.

**STEM-OPT extension**

- File **up to 90 days before** your current OPT expires, and it **must be filed before** it expires.
- Duration: **24 months**; **60-day grace period** afterward.
- A timely-filed pending application keeps work authorization alive for up to **180 days** past the OPT
  end date.
- Reporting: validation reports at **6, 12, and 18 months**, the **12-month self-evaluation**, and the
  **final I-983 self-evaluation** at the end.
- 150 aggregate days of unemployment across OPT plus STEM-OPT.

**CPT**

- **Full-time CPT (more than 20 hrs/week)** accumulates toward a **365-day cap**; at **365 days or more**
  you become **ineligible for OPT** at that degree level. The app shows a running meter and warns from
  300 days.
- Part-time CPT (20 hrs/week or less) does not count toward that cap.
- CPT **must be authorized on your I-20 before the start date**; the app adds a reminder a week ahead of
  each start date.

---

## Project layout

```
index.html                 App shell, all tabs, glossary, resources, disclaimer, scan dialog
styles.css                 Responsive, light/dark, no framework
app.js                     Date rules, storage, rendering, .ics export, Drive backup
scan-core.js               Document reader logic: date parsing, label matching, image prep (no DOM)
scan-ui.js                 Document reader UI and browser adapters for Tesseract.js and pdf.js
config.js                  Optional Google OAuth Client ID (public identifier, no secret)
manifest.json              PWA manifest
sw.js                      Service worker (caches this origin's files only)
icons/                     App icons (SVG source + generated PNGs)
vendor/                    Tesseract.js, its WebAssembly engine and English data, pdf.js (Apache-2.0)
scripts/vendor.js          Regenerates vendor/ from node_modules
tests/rules.test.js        Deadline rules
tests/scan.test.js         Document reader logic
tests/scan-e2e.js          OCR accuracy harness (Node)
tests/scan-harness.html    OCR accuracy harness (browser, includes PDFs)
tests/fixtures/            Synthetic document generator
.nojekyll                  Tells GitHub Pages to serve the folder as-is
```

Run the unit tests with no dependencies at all:

```bash
npm test
```

## Third-party code

`vendor/` contains unmodified builds of [Tesseract.js](https://github.com/naptha/tesseract.js) and
tesseract.js-core, the Tesseract `eng` LSTM model (tessdata_best_int), and
[pdf.js](https://github.com/mozilla/pdf.js), all under the Apache License 2.0. Their license files are
kept alongside them.

---

## No server, no database — confirmed

There is **no backend service, no API of ours, no database, no hosted function, and no log** in this
project. The complete deployment is the static files listed above, served by GitHub Pages. User data
exists in exactly two places, both controlled entirely by the user: their own browser's `localStorage`,
and — only if they choose it — their own Google Drive, reached directly from their browser with their own
credentials. Scanned documents exist only in the browser's memory while the scan dialog is open.

## License

MIT — see [LICENSE](LICENSE).
