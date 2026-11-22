# Staging a load

Load data used to write a file straight to live records. A file can now be staged first: what the load would do is kept as a batch, checked against the data quality rules, corrected where it is wrong, and only then promoted. A promoted batch can be reverted.

Staging is on the review screen of a file at `/imports`, as the last two steps: Stage and check, then Promote.

## Parts

| Part | Where | What it does |
|---|---|---|
| Tables and functions | `supabase/migrations/20261119100000_load_batches.sql` | `load_batches` and its records, values and journal; `load_batch_quality`; `load_batch_revert`; the `load.promote` permission; a `load_batch_id` column on values, links and records |
| What the loader tells | `packages/mcp-server/src/feeds/feed-loader.ts` (`LoadRecorder`) | A dry run reports each record and value it would write. A real load reports each live row it replaces |
| Batch rows | `packages/mcp-server/src/feeds/load-batch-store.ts` | Opening a batch for a load that was not staged, the journal, corrections laid over the file's rows, drift |
| Staging flow | `packages/mcp-server/src/feeds/load-batches.ts` | Stage, read, correct, promote, revert, discard |
| Agent tools | `packages/mcp-server/src/tools/position-file-tools.ts` | `stage_position_file_import`, `list_load_batches`, `get_load_batch`, `get_load_batch_values`, `edit_staged_value`, `promote_load_batch`, `revert_load_batch`, `discard_load_batch` |
| API | `apps/web/app/api/feeds/position-file/[id]/stage`, `apps/web/app/api/feeds/batches/[id]` | What the screen calls |
| Screen | `apps/web/components/feeds/StagedBatch.tsx` | The Stage, check, promote panel |

## What a batch goes through

| Status | Meaning |
|---|---|
| `STAGED` | The plan is stored. Nothing live has changed |
| `PROMOTING` | The loader is writing it |
| `PROMOTED` | Written |
| `FAILED` | The promote stopped part way. What it wrote can still be reverted |
| `REVERTED` | Taken back |
| `DISCARDED` | Dropped before it was promoted |

A file has one staged batch at a time. Staging it again replaces the earlier one.

## Staging

Stage runs the real loader without writing, the same dry run Review uses, and keeps what it reports:

- each record the file names, and whether it would be created or matched to a stored one;
- each value: what the file says, what would be stored, what is held today, and whether it would be added, changed, or is already stored;
- the row and column of the file each value came from.

When a record in the file matches more than one stored record, nothing is staged. The choices are shown, and the file is staged with the decisions.

## The checks

`load_batch_quality` runs every active data quality rule on each staged record **as it would stand once the batch is promoted**: the record's live values on the batch date with the staged values laid over them, by the same source precedence the live data uses. These are the compiled rules the data quality page runs.

A matched record is also checked as it stands today, which is how each failure is put in one of two groups:

| Group | Meaning |
|---|---|
| Failures this batch brings | The record passes today, or is new, and would fail once promoted |
| Already failing | The record fails the rule today and would still fail |

The result also lists checks the batch clears, required values still missing, and values a higher-ranked source will keep overriding (the file's value would be stored but would not become the record's value).

Two limits:

- Calculated values are not recalculated for the check. A rule on a calculated attribute sees the value live today.
- A rule is run on one record's own values. A failure a person has accepted on a record is left out, as on the data quality page.

## Correcting a value

A failing value that came from one cell of the file has a Correct button. The correction is held to the attribute's type, stored on the batch with who made it and why, and the checks run again. The stored file is never changed: the correction is laid over its rows when the batch is promoted, and goes through the loader's own cleanup like any other value. Saving a blank value takes the correction back.

## Promoting

Promote runs the real loader on the stored file with the staged mapping, decisions and corrections. What is written is decided at that moment, against the data as it is then, so there is one write path and a batch that waited a week cannot write a stale plan. If the counts differ from what was staged, the batch lists the differences.

- A batch that brings a **critical** failure is held. Correct the values, or give a reason to promote anyway; the reason is kept on the batch.
- Promoting and reverting need `load.promote`. Client admins have it. Staging, correcting and discarding need only what loading a file needs.
- If the data changed so that a record now matches more than one stored record, nothing is written and the batch stays staged. Stage the file again to choose.

## Loads that are not staged

A feed, a workflow step, and Load now on the screen still write straight to live records. Each opens a batch of its own, marked `DIRECT`, so it is stamped and journaled like a promoted one and can be reverted. It has no staged plan and no checks.

Until the migration is applied, loads run exactly as before with no batch, and Stage says staging is not set up.

## Reverting

`load_batch_revert` takes back what a batch wrote, where it still stands:

| What the batch did | Revert |
|---|---|
| Added a value | Retires it by closing its system time, so history keeps it. Left alone if a later load rewrote it |
| Changed a value, or ended its period (`VALUE_SUPERSEDE`) | Retires the replacement and makes the earlier row current again. Left alone if something written since holds that period for that source |
| Changed a value in place, or closed its period (`VALUE_UPDATE`, `VALUE_CLOSE`, batches loaded before 2026-11-22) | Puts it back as the journal recorded it. Left alone if it has changed again |
| Added a link | Removes it |
| Closed a link | Reopens it |
| Renamed a record | Restores the name, unless it was renamed again |
| Created a record | Makes it inactive when it holds no other current value or link |

The result counts what was reverted and what was left alone.

A load never changes a value row in place. To correct a value or end its period it calls `golden_master.supersede_value`, which ends the row as current knowledge and writes a changed copy, so a question asked as of an earlier Knowledge date still gets the answer known then ([BI_TEMPORAL.md](BI_TEMPORAL.md)).

## Not built yet

- The Fund reconciliation template still loads with `load_position_file_table`. The File intake workflow stages, checks and promotes as a guided run: see [WORKFLOWS.md](WORKFLOWS.md#stages).
- A staged-values grid. The screen shows the checks and counts; `get_load_batch_values` returns the values.
- Correcting a value that did not come from one cell, such as an as-of date read from a title.
- Link changes are counted on a staged batch, not listed.
- Staging holds values, not schema. A new field accepted during mapping is still created at once.
- The data specialist's own load (`run_load_session`) is neither staged nor given a batch.
- Promote is not one database transaction. A promote that stops part way is `FAILED` and is reverted as a whole.
