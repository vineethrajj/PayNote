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
3. In the editor, create the two files from this repo (use the same names):
   - `Code.gs` — paste the contents of `Code.gs`.
   - `Index.html` — **File → New → HTML file**, name it `Index` (Apps Script
     adds the `.html`), and paste the contents of `Index.html`.
4. Save.

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

`tests/run_tests.js` loads the **actual `Code.gs`** into a Node VM with the
Apps Script globals stubbed (an in-memory sheet, canned Anthropic responses)
and runs 160+ edge-case assertions covering all of the above — including
proof that existing rows are never mutated and the sheet only ever grows
downward.

```bash
node tests/run_tests.js
```

No dependencies; needs only Node. These tests are for local development —
Apps Script itself does not run them.

## Files

| File | Purpose |
|------|---------|
| `Code.gs` | Backend: `doGet` (serves the page), `parsePayment` (Anthropic call + retries + normalisation), `appendPayment` (append-only sheet write), `isPinRequired`/`checkPin_` (optional PIN), and read-only / sample diagnostics. |
| `Index.html` | The single-page mobile front-end: raw-entry field, editable confirmation card, missing-field enforcement, amount sanitiser, install meta tags, embedded tooth icon. |
| `tests/run_tests.js` | Node edge-case harness that exercises the real `Code.gs` functions. |
| `README.md` | This file. |
