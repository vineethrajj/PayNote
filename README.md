# Bill Note — Joseph Dental & Aesthetic Wellness

A mobile web app for front-desk staff. Type (or dictate with the phone
keyboard's mic) one rough sentence like:

> *Prashanth paid 2000 cash for scaling*

…and the app parses it into a structured row, shows an **editable
confirmation card**, and — only after you tap **Confirm** — appends it to the
clinic's Google Sheet ledger.

It is built as a **single Google Apps Script Web App**: no separate server, no
other hosting. The same script serves the phone front-end, calls the Anthropic
API server-side to parse the text, and appends the confirmed row to the sheet.

```
Phone (installed web app)
  → staff types / dictates a rough line, taps "Read it"
  → Apps Script parsePayment(): sends text to Claude, gets structured JSON
  → front-end shows an editable confirmation card
  → staff taps "Confirm & save"
  → Apps Script appendPayment(): appends ONE row to "Transactions"
```

---

## What gets written to the sheet

Tab: **`Transactions`**. Columns, in exact order:

| # | Column | Value written |
|---|--------|---------------|
| 1 | Date | JS `Date` — the moment of entry |
| 2 | From / Party | patient or vendor name |
| 3 | Particulars | service / expense description |
| 4 | Bank Details | the payment mode (e.g. `GPay`) |
| 5 | Method | `Cash` if mode is Cash, else `Online` |
| 6 | Debit (₹) | the amount **only if** direction = debit, else blank |
| 7 | Credit (₹) | the amount **only if** direction = credit, else blank |
| 8 | Type | `DR` (debit) or `CR` (credit) |
| 9 | Source | always `Bill Note` |
| 10 | Month | `MMM yyyy`, e.g. `Jul 2026` |
| 11 | Notes | free text, optional |

**Direction:** `credit` = money **received** from a patient. `debit` = money
the clinic **paid out** (lab bill, consultant fee, supplies, rent…).

### Month-header behaviour (append-only)

The sheet groups rows under `◆  <Month Year>` header rows in column A. On each
save the script:

1. Reads the **Month value (column J) of the current last row**.
2. If it **matches** the new entry's month → appends the entry directly below.
3. If it **doesn't match** (a new month has started) → writes a
   `◆  <Month Year>` header row first, then the entry row below it.

> **Safety guarantee:** the script is **append-only**. It only ever writes at
> `getLastRow() + 1`. It never inserts, edits, deletes, or reorders existing
> rows, so the formulas in the Dashboard, Expense Tracker, Payment Tracker, and
> Monthly Summary tabs are never disturbed.

---

## Deployment

### 1. Create the Apps Script project bound to the spreadsheet

1. Open the ledger spreadsheet:
   `https://docs.google.com/spreadsheets/d/1IH0kwzT0UQAHkWuczVGpbv44S_gSYa-y/`
2. **Extensions → Apps Script**. This creates a *container-bound* script that
   already has access to this spreadsheet.
3. In the editor, create these files from this repo (use the same names):
   - `Code.gs` — paste the contents of `Code.gs`.
   - `Consolidate.gs` — **File → New → Script file**, name it `Consolidate`,
     and paste the contents of `Consolidate.gs` (the statement-import backend;
     it shares helpers with `Code.gs`).
   - `Index.html` — **File → New → HTML file**, name it `Index` (Apps Script
     adds the `.html`), and paste the contents of `Index.html`.
4. Save. (For Excel statement import, also enable the advanced Drive service —
   see *Statement import & consolidation* below.)

> Note: the front-end talks to the backend via `google.script.run` (not a raw
> HTTP `POST`). Because the page is served by this same script, that is the
> standard, CORS-free way to call the server functions — parsing and sheet
> writes still happen entirely server-side, and the API key never reaches the
> browser.

### 2. Set the Script Properties

**Project Settings** (gear icon) → **Script properties** → add:

| Property | Value | Required? |
|----------|-------|-----------|
| `ANTHROPIC_API_KEY` | your Anthropic API key (`sk-ant-…`) | **Yes** |
| `SPREADSHEET_ID` | a spreadsheet ID to write to | Recommended (see safety note) |
| `APP_PIN` | a shared numeric PIN for staff | Optional (see Security) |

- **`ANTHROPIC_API_KEY`** is read server-side only, via
  `PropertiesService.getScriptProperties()`. It is never sent to the browser.
- **`SPREADSHEET_ID`** overrides the built-in ID. **Set it to a TEST COPY first**
  (see *Test before going live* below). Remove it (or set the live ID) only when
  you're satisfied. If unset, the script falls back to the live ledger ID baked
  into `Code.gs`.

### 3. Deploy as a Web App

1. **Deploy → New deployment → ⚙ → Web app.**
2. Configure the **Security** settings:
   - **Execute as:** *Me* (your Google account). This lets the script write to
     the sheet on staff's behalf without each of them needing edit access.
   - **Who has access:** see the trade-off table in **Security** below.
3. **Deploy**, authorise the scopes when prompted (spreadsheet access +
   external requests for the Anthropic call), and copy the **Web app URL**.

Re-deploy (**Deploy → Manage deployments → edit → Version: New version**) any
time you change the code.

---

## Test before going live (do this first)

**Do not point the app at the live ledger until you've done a dry run.** Write
access to the real sheet is not safe to assume.

1. **File → Make a copy** of the ledger spreadsheet. Copy its ID from the URL
   (`…/spreadsheets/d/THIS_PART/…`).
2. Set the `SPREADSHEET_ID` script property to the **copy's** ID.
3. In the Apps Script editor, run **`diagnostic_readOnly`** from the function
   dropdown and check **Executions / Logs**. It opens the sheet and reports the
   last row and whether the API key is set — **without writing anything**.
4. Run **`diagnostic_appendSample`** once. It appends a single ₹1 test row.
   Open the copy and confirm:
   - the row landed **below** the previous last row (nothing above it moved);
   - a `◆  <Month Year>` header was created if it was a new month;
   - all 11 columns match the format table above.
5. Open the Web app URL on your phone and run a couple of real sentences end to
   end against the copy.
6. Only when all of that looks right, set `SPREADSHEET_ID` to the **live**
   ledger ID (or delete the property to use the built-in default) and
   re-deploy a new version. Delete the ₹1 test rows from the copy — or just
   discard the copy.

---

## Install on iPhone (Add to Home Screen)

1. Open the **Web app URL** in **Safari** (not Chrome — only Safari can install
   a full-screen web app on iOS).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the new **Bill Note** icon (a tooth on teal). It opens
   **full-screen**, with no Safari address bar — the meta tags
   (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
   the locked viewport, and the `apple-touch-icon`) handle that.

**Dictation:** there is intentionally **no custom mic button** — iOS Safari's
speech API is unreliable once a page is installed to the home screen. Instead,
tap the text field and use the **mic icon on the iOS keyboard** to dictate.
The field is a normal input, so this just works.

**Android (secondary target):** open the URL in Chrome → menu → *Add to Home
screen / Install app*. Same responsive layout; use the keyboard mic to dictate.

---

## Security

The API key is only ever in **Script Properties**, read server-side — never in
the front-end.

For **who can reach the Web app**, choose one (all set on the deployment):

| Option | How | Trade-off |
|--------|-----|-----------|
| **Anyone with the link** | *Who has access: Anyone* | Simplest, no staff logins. Risk: anyone who gets the URL can post entries — **link leakage is the whole security boundary**. |
| **Anyone in your Workspace** | *Who has access: Anyone within [clinic domain]* | Safer — only signed-in clinic Google accounts. Requires every staff member to have a clinic Google login and stay signed in. |
| **Shared PIN** | *Anyone with the link* **+** set the `APP_PIN` script property | Middle ground: the link is not enough on its own; staff must also enter a PIN that every server call validates. Easy to rotate — just change the property. |

**What this build ships with, and how to switch:**

- The code supports the **shared-PIN** option out of the box. If you set an
  `APP_PIN` script property, the app shows a PIN gate on launch and the server
  rejects any parse/save that doesn't carry the correct PIN
  (`checkPin_` in `Code.gs`). If you **don't** set `APP_PIN`, no PIN is asked
  for — so the default with no further configuration is **"Anyone with the
  link"**, the simplest option.
- **Recommended:** deploy as *Anyone with the link* **and** set an `APP_PIN`.
  You get a shareable URL plus a second factor you can rotate anytime.
- To move to Workspace-only later, just change **Who has access** on the
  deployment to your clinic domain — no code change needed. You can drop the
  PIN at that point if you like.

---

## Statement import & consolidation

The **Import statements** tab lets staff upload multiple account/wallet
statements at once (Axis, SBI, Paytm, GPay), and the app consolidates them
into the ledger — parsing every transaction, deduplicating across the files
**and** against what is already recorded, then appending only what is new.

**Flow:** pick files → *Parse & preview* → review the new-vs-skipped preview
→ *Append new to ledger*. Nothing is written until you tap append.

**Formats**
- **CSV / Excel** are parsed inside Apps Script using fuzzy column detection,
  so each bank's different layout (and the metadata rows many statements put
  above the header) is handled without hard-coding every schema.
- **PDF** statements are sent to Claude's document API, which returns the
  transactions as JSON that the app then normalises.

**Deduplication (smart match).** Two rows are treated as the same transaction
when they have the **same amount and direction** AND either the **same
reference/UTR** or a **date within ±1 calendar day with a fuzzy counterparty
match**. This catches:
- the same UPI payment appearing in both a wallet export and its linked bank
  statement (cross-source), and
- a statement row that is already in the ledger (entered manually via the
  quick-log tab, or from an earlier import) — those are skipped.

Opposite-direction rows of the same amount (e.g. a bank→wallet transfer) are
**not** merged, since they are two legs of one movement, not a duplicate.

**Append ordering — important.** Imports respect the same append-only rule as
the rest of the app: they land as a **reconciliation block at the bottom** of
the sheet, ordered by date within the batch, with `◆ Month` headers as the
month changes. The app **cannot** interleave historical rows back up into
earlier months — inserting mid-sheet would shift every row below and break
the formulas the other tabs depend on. So a July import done in September is
correct and de-duplicated, but it sits after the existing September rows, not
back under July. Dedup is by content (amount/direction/date/name), so this
ordering never causes double-counting.

### Extra setup for Excel (.xlsx) import

Excel files are converted to a temporary Google Sheet via the **advanced
Drive service**, which must be enabled once:

1. Apps Script editor → **Services** (＋) → add **Drive API** (identifier
   `Drive`) → **Add**.
2. Re-deploy. (The temporary conversion file is created and deleted
   automatically per import.)

If you'd rather not enable it, **export those accounts as CSV** instead —
CSV needs no extra service.

### PDF import caveats

- Runs against Claude's document API, so it is **slower and costs more** than
  CSV/Excel, and quality depends on the PDF (clean digital statements parse
  well; scanned/photographed ones are unreliable).
- Apps Script has a **6-minute execution limit** and requests have size
  limits — import a **few statements at a time**, not a year of large PDFs at
  once.
- **Always dry-run PDF import against the test copy first** and eyeball the
  preview before appending — treat the model's extraction as a draft.

## Installing on iPhone & sharing via WhatsApp

**There is no `.ipa` file to download and tap-install from WhatsApp.** That is
an Apple restriction, not a limitation of this project: stock iPhones only
install apps from the App Store, TestFlight, or ad-hoc signing that bakes in a
specific device's UDID plus a paid Apple Developer certificate. iOS has no
Android-style "open the file to install."

The real, friction-free install path — and the one this app is built for — is
**PWA install via Safari**:

1. Open the deployed web-app link in **Safari**.
2. **Share → Add to Home Screen → Add.**
3. It launches full-screen from its own tooth icon, exactly like a native app
   (the `apple-mobile-web-app-*` meta tags handle that).

So the thing you send over WhatsApp is the **link**, not a file.

**`install.html`** is a self-contained install page to make that easy: open
it, paste your deployed `…/exec` URL, and it gives you a **Copy WhatsApp
invite** button and a **Send on WhatsApp** button (a `wa.me` deep link) with a
ready-written message that includes the link and the Add-to-Home-Screen steps.
You can host `install.html` anywhere, or just use it locally to compose the
invite.

**`tools/make_qr.py`** generates a QR code PNG pointing at your app link — good
for printing at the front desk or forwarding — so staff can scan with the
iPhone Camera app and then Add to Home Screen:

```bash
python3 tools/make_qr.py "https://script.google.com/macros/s/…/exec"
# or:  npm run qr -- "https://…/exec"
```

## Android: a real installable APK

Unlike iOS, Android **can** install an app from a file. `android/BillNote.apk`
is a signed, sideloadable app you can send over WhatsApp and tap to install:

1. Send `BillNote.apk` to the phone (WhatsApp, email, or a cable).
2. Tap it. Android asks to **allow installing unknown apps** for WhatsApp/Files
   the first time — allow it, then **Install**.
3. Open **Bill Note**. On first launch it asks for the clinic's app link —
   paste your deployed `…/exec` URL once (saved on the device). It then loads
   the app full-screen every time. Change it later from the ⋮ menu → *Change
   app link*.

**Why a WebView shell, not a PWA:** Apps Script serves its web apps inside a
sandboxed iframe, which blocks a true Android PWA/WebAPK install. This shell
(`android/app/…/MainActivity.java`, ~200 lines, framework APIs only — no
AndroidX) loads the same live web app, wires up `<input type="file">` so the
statement-import picker works, handles the back button, and installs like any
normal app. The deployed URL is **not** hard-coded, so one APK works for any
deployment.

**Rebuild it yourself** (e.g. after changing the app, or to sign with your own
key) — needs a JDK and an Android SDK with `platforms;android-34` and
`build-tools;35.0.0`:

```bash
ANDROID_SDK_ROOT=/path/to/sdk bash android/build.sh
# -> android/BillNote.apk  (debug-signed; fine for sideloading)
```

`android/build.sh` runs the toolchain directly (aapt2 → javac → d8 → zipalign →
apksigner); no Gradle/Android Studio required. The shipped APK is **debug-key
signed**, which is all that sideloading needs — for Play Store distribution
you'd re-sign with a release key.

> The APK is a thin shell: all the app logic and every test in this repo cover
> the web app it loads. I verified the APK's structure (manifest, permissions,
> launcher icon, dex classes, and v1/v2/v3 signatures) but could not boot an
> Android emulator in the build environment, so do a quick real-device smoke
> test after installing.

## Look & feel

The UI is theme-aware (light **and** dark), tuned for iPhone 12: gradient
brand header, pill tab switch, segmented direction control, gradient CTAs, a
launch splash, and full safe-area/notch handling. It also works as a
responsive page on Android Chrome.

## Real-browser validation

`tests/ui_validate.js` loads the **actual `Index.html`** in Chromium at the
iPhone 12 viewport (390×844 @3×) with a mocked `google.script.run`, drives the
live flows, **fails on any console/page error**, and captures light + dark
screenshots:

```bash
npm run test:ui      # needs the bundled Chromium
```

It verifies: boot + splash auto-hide, quick-log parse → populated confirmation
card with the right direction, tab switch, file pick enabling parse, and the
import preview rendering the correct number of new rows. Screenshots land in
`tests/screens/` (git-ignored; regenerate any time).

## Robustness & tests

Rough human phrasing is Claude's job to parse, but the model can still hand
back messy JSON. Every value coming back is defensively normalised and every
value going into the sheet is re-validated server-side, so a bad parse
degrades to "ask the human to fill it in" rather than a broken row:

- **Amounts** accept `2000`, `"2,000"`, `"₹2000"`, `"rs 2000"`, `"2k"`,
  `"1.5k"`, `"2 lakh"`, `"1 crore"` — and reject negatives/garbage (→ 0,
  which the UI then forces the user to fill). Capped at ₹10 crore.
- **Modes** map `gpay`/`google pay`/`g-pay` → `GPay`, `credit card`/`swipe`
  → `Card`, `phonepe`/`upi`/`cheque`/`bank transfer` → `Other`, etc.
- **Direction** maps `received`/`collected` → credit, `paid`/`expense` →
  debit; anything ambiguous stays blank for the human.
- **Model output** is unwrapped from code fences / surrounding prose, and a
  total parse failure returns a blank card instead of erroring.
- **The Anthropic call** retries with backoff on 429 / 5xx / network errors.
- **The sheet write** takes a script lock (concurrent front-desk submits),
  re-validates required fields, and is strictly append-only — including the
  edge case where the last row is already a month header (it appends under
  it instead of duplicating it).

Two Node harnesses load the **actual `Code.gs` and `Consolidate.gs`** into a
VM with the Apps Script globals stubbed (an in-memory sheet, canned Anthropic
responses) and run **241 edge-case assertions** — including proof that
existing rows are never mutated and the sheet only ever grows downward:

- `tests/run_tests.js` — the quick-log path (rough amount/mode/direction
  parsing, messy JSON extraction, validation, month headers, retries, PIN).
- `tests/consolidate_tests.js` — the import path (fuzzy column detection
  across Axis/SBI/Paytm/GPay-style layouts, date/money parsing, cross-source
  and cross-ledger dedup, append-only chronological commit, mocked PDF).

```bash
npm test          # runs both suites
```

No dependencies; needs only Node. These tests are for local development —
Apps Script itself does not run them. Because the file-format adapters can't
be verified here without real exports, **validate a real statement of each
type against the test copy** before trusting import on the live ledger.

## Files

| File | Purpose |
|------|---------|
| `Code.gs` | Quick-log backend: `doGet` (serves the page), `parsePayment` (Anthropic call + retries + normalisation), `appendPayment` (append-only sheet write), `isPinRequired`/`checkPin_` (optional PIN), and read-only / sample diagnostics. |
| `Consolidate.gs` | Statement-import backend: multi-format parsing (CSV/Excel/PDF), fuzzy column detection, normalisation, cross-source + cross-ledger smart dedup, and `previewConsolidation` / `commitConsolidation` (append-only batch commit). |
| `Index.html` | The single-page mobile front-end: Log-payment tab (raw entry → editable confirmation) and Import-statements tab (file upload → preview → append), install meta tags, embedded tooth icon. |
| `install.html` | Self-contained install/onboarding page: iPhone Add-to-Home-Screen steps + WhatsApp invite (copy + `wa.me` share) driven by your deployed URL. |
| `android/` | Sideloadable Android app: `BillNote.apk` (prebuilt, signed), the WebView shell source, and `build.sh` to rebuild it. |
| `tools/make_qr.py` | Generates a QR-code PNG for the app link (print or forward). |
| `tests/run_tests.js` | Node harness for the quick-log path. |
| `tests/consolidate_tests.js` | Node harness for the statement-import path. |
| `tests/ui_validate.js` | Real-browser (Chromium, iPhone 12) validation with screenshots. |
| `package.json` | `npm test` (unit), `npm run test:ui` (browser), `npm run qr`. |
| `README.md` | This file. |
