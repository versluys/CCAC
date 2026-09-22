# private/

Nothing in this directory is ever committed, except this file.

It holds the parish data that must not leave the machine (PRD requirement R-P1):

| File | What it is |
|---|---|
| `Christ_s_Chapel_..._Donor_Contact_List.xlsx` | The donor export. Names, emails, phones, addresses. |
| `households_geocoded.csv` | Written by `ingest.py`. Full street addresses with coordinates. |
| `attender_zips.csv` | The Sunday ZIP card: `zip,household_size,joined_within_12mo`. No names. |
| `address_overrides.csv` | Parish-confirmed address corrections, keyed on donor name. |

## address_overrides.csv

The giving record is a billing record, not a residence register. When a donor's
address on file is stale or belongs to a relative in another county, correct it
here rather than editing the workbook:

```csv
match_name,override_zip,note
Jane Smith,92501,"Confirmed by the treasurer, 2026-09-22."
```

`match_name` is matched case-insensitively as a substring against the donor
name columns. `ingest.py` applies the correction before the address is used for
anything, so the wrong ZIP never reaches a geocoder or the map. The published
record is flagged `corrected` without recording who was corrected.

Because this file keys on donor names, it is PII and cannot be committed. It
does not survive a fresh clone — keep a copy somewhere safe, or recreate it.

## attender_zips.csv

```csv
zip,household_size,joined_within_12mo
92506,4,N
92503,2,Y
```

One row per attending household. ZIP only, no names, collected on a Sunday card.
This is what corrects the giving record's bias toward longer-tenured members.

## Verifying the boundary holds

```bash
.venv/bin/python scripts/check_pii.py
```

It fails if any donor name, email, phone or street address reached `data/`, or
if git is tracking anything in here.
