# Cleanroom — master data quality auditor

**Find the bad data before it reaches the ERP.**

ERP implementations rarely fail because the software is wrong. They fail at data migration —
duplicate vendors, missing tax IDs, five spellings of "Karachi", credit limits with a decimal in
the wrong place. Nobody audits the master data until it is already loaded, and by then the defects
are transactions.

Cleanroom reads a master data file, scores it across six quality dimensions, and turns the findings
into a remediation plan a migration lead can action.

**Live demo:** https://yousufhasan48017.github.io/cleanroom/
*(Open it and press "Audit the sample vendor master" — the sample is a deliberately messy vendor
master of 48 Pakistani suppliers.)*

---

## The design decision that matters

Most "AI tools" hand the whole problem to a language model and hope. This one splits it:

| | Who does it | Why |
|---|---|---|
| **Profiling** — what does each column *mean*? Which rules apply? | Language model | Genuinely hard to hardcode. Every client's file has different headers. |
| **Judging** — does this value pass? What is the score? | Deterministic rules engine | A quality score that changes between runs is not a quality score. |

The model never produces a number. Every count, score and verdict comes from `engine.js`, so the
same file always produces the same result and any finding can be traced to the rule that raised it.
That is the difference between something you can show a client and something you cannot.

If no model endpoint is configured, a built-in heuristic profiler takes over and the tool still
works end to end — which is why the public demo needs no API key.

---

## What it checks

Six dimensions, weighted for an ERP cutover rather than weighted equally:

| Dimension | Weight | Question |
|---|---:|---|
| Uniqueness | 25% | Is each real-world entity stored once? |
| Completeness | 20% | Are mandatory fields populated? |
| Validity | 20% | Do values match the required format? |
| Consistency | 15% | Is the same thing written the same way? |
| Accuracy | 15% | Are the values plausible? |
| Timeliness | 5% | Have records been maintained recently? |

Uniqueness carries the most weight because duplicate master records are the defect that survives
migration and keeps costing money afterwards: split spend, drifting payment terms, duplicate
payments.

**Scoring is severity-weighted.** A failed cell is not worth the same as any other failed cell — a
duplicate vendor costs 3× a trailing space. Without this, a file with six duplicate vendor groups
scored an A, which was flattering and useless.

### Detection worth calling out

- **Fuzzy duplicate matching.** Legal suffixes (`Limited`, `Pvt`, `Company`, `The`) are stripped
  before comparison, then remaining names are compared by token-set Jaccard similarity. This is
  what catches *Searle Pakistan Limited* / *The Searle Company Ltd.* / *SEARLE PAKISTAN LTD* as one
  vendor. Exact matches on tax ID and fuzzy matches on name are then merged into a single group per
  real-world entity.
- **Locale-aware format rules.** Pakistani NTN (`#######-#`), local phone formats, ISO dates.
- **Alias-aware consistency.** `Khi` → `karachi`, `PAK` → `pakistan`, `Rs.` → `pkr`, `Food and
  Beverage` → `Food & Beverage`, so variants group even when they are not just a casing difference.
- **Plausibility, not just format.** Negative credit limits, a 9,999-day payment term, amounts more
  than 20× the column median, dates in the future.

### Output

- An overall score, letter grade, and a migration verdict — **Ready / Conditional / Not ready**
- Per-dimension scores with the cells checked and the cells failed
- Duplicate groups with a suggested survivor record
- A field-level profile: detected type, fill rate, defect count
- A filterable issue log — every finding with its line number and a recommended fix
- A **remediation plan grouped by root cause**, because a migration lead needs five decisions, not
  four hundred rows. Each item carries evidence, cause, business impact, the fix, effort and owner.
- Exports: issues as CSV, plan as Markdown

On the sample file the verdict is *Conditional go* at **81/100** — Uniqueness 56.3 is the number
that matters, and the plan leads with it.

---

## Running it

No build step, no dependencies, no server required.

```bash
git clone https://github.com/yousufhasan48017/cleanroom.git
cd cleanroom
# open index.html in a browser, or serve the folder
```

Tests:

```bash
node test/engine.test.js     # 54 assertions, no test framework
```

The audit date is pinned in the tests so scores are reproducible.

After editing the sample CSV, regenerate the embedded copy the demo uses:

```bash
node tools/build-sample.js
```

---

## Connecting a model

Open **AI settings** in the app and paste a webhook URL — an n8n workflow, a Cloudflare Worker,
anything that speaks JSON. It is stored in your browser only.

Your endpoint receives:

```json
{
  "mode": "profile",
  "headers": ["vendor_code", "vendor_name", "ntn"],
  "sample": [{ "vendor_code": "V-1001", "vendor_name": "Searle Pakistan Limited", "ntn": "1234567-8" }]
}
```

and must reply:

```json
{
  "fields": [
    { "name": "vendor_code", "semantic": "identifier", "mandatory": true, "unique": true },
    { "name": "vendor_name", "semantic": "name", "mandatory": true, "identity": true },
    { "name": "ntn", "semantic": "taxid", "mandatory": true, "unique": true }
  ]
}
```

Valid `semantic` values: `identifier`, `name`, `taxid`, `email`, `phone`, `city`, `country`,
`currency`, `category`, `integer`, `amount`, `date`, `status`, `text`.

A second call with `"mode": "narrative"` sends the finished scores and asks for a short written
summary, which is displayed above the plan and clearly labelled as model-written. Both calls are
optional; a failure falls back to the heuristic profiler rather than breaking the audit.

---

## Files

```
index.html            interface
styles.css            design tokens and layout
app.js                rendering, filtering, exports, the model integration
engine.js             the rules engine — parsing, profiling, scoring (no dependencies)
data/vendor-master.csv  sample: 48 vendors with planted defects
data/sample.js        generated copy so the demo runs straight off disk
test/engine.test.js   54 assertions
tools/build-sample.js regenerates data/sample.js from the CSV
```

---

## Limitations

Worth stating plainly, because a tool that pretends to be finished is not credible:

- **CSV only.** No Excel, no direct ERP connection.
- **Single-table.** It audits one file at a time; it does not check referential integrity between
  master tables.
- **The rules are opinionated toward a Pakistani vendor master** — NTN format, local phone shapes,
  a city alias list. Other domains need the alias and format tables extended.
- **Fuzzy matching is tuned, not learned.** The 0.6 similarity threshold catches the cases in the
  sample; a much larger file would want the threshold reviewed against a labelled set.
- **Everything runs in the browser.** Convenient and private, but not suited to files of hundreds
  of thousands of rows.

---

Built by [Yousuf Hasan](https://yousufhasan48017.github.io) — business analyst, Karachi.
