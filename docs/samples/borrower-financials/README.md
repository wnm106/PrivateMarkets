# A sample borrower package

Two files to test the Borrower financials workflow ([WORKFLOWS.md](../../WORKFLOWS.md#borrower-financials)) on the Halyard Systems sample borrower. They are made up.

| File | What it is |
|---|---|
| `halyard-systems-q3-2026-statements.csv` | The statement lines for the quarter to 30 September 2026, one row. It is the statement already on file with three lines restated, as a final package would restate a preliminary one |
| `halyard-systems-q3-2026-compliance-certificate.csv` | The three covenants as the borrower certifies them |

## What the statements file changes

| Line | On file | In the file | Difference |
|---|---|---|---|
| General and administrative | $3,358,173.93 | $3,778,173.93 | +$420,000.00 |
| Cash and equivalents | $53,939,091.12 | $53,519,091.12 | −$420,000.00 |
| Restricted cash | $6,472,691.00 | $9,972,691.00 | +$3,500,000.00 |

Gross profit and EBITDA are in the file but are calculated by the platform, so they are not loaded. The file's EBITDA of $10,550,034.86 is what the platform gives once the higher cost is loaded.

## What to expect

- EBITDA for the quarter falls by $420,000, so adjusted EBITDA for the last four quarters falls and net leverage rises from 2.97x to about 3.00x, against a limit of 3.25x.
- Liquidity falls by $3,920,000, to about $43.5M, because less cash is unrestricted. The certificate still says $47.5M, so it now differs from the calculation.
- The certificate says net leverage is 2.76x. Our calculation is higher, and the review should say so.

## Running it

1. Start Borrower financials on Halyard Systems (`HALY-ISS-HALYARD`) with the quarter end 2026-09-30.
2. On "Hand this run its file", upload both files, choose the statements file, and use it. The certificate stays stored for the reviewing agent to read.
3. Confirm what the file is, confirm the mapping with the quarter end as the date, and approve the staged batch.
4. In "Review the quarter", check each certificate value and read the notes.

Loading the statements file changes the sample borrower's figures. To put them back, load a file with the values in the On file column. The earlier values stay in each line's history either way.
