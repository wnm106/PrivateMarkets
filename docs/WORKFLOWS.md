# Workflows

A workflow is a multi-step automation: find something, have an agent work on it, get a person's approval, make the change, report. Workflows, their runs, and the reviews waiting for a person are at `/workflows`.

Three kinds of step, drawn in three colours everywhere a workflow is shown:

| Kind | Steps | What it does |
|---|---|---|
| Fixed | Run a tool, Condition, Split, Join, Apply approved changes, Call a connection, Send a message, Start, End | The same thing every run |
| Agent | Agent | A model reads with the tools the step lists and proposes changes. It has no tool that changes data |
| Human | Human review, Ask for information, Stage | The run stops until a person approves what was proposed, answers a form, or works through a screen |

The rule the engine keeps: **an agent proposes, a person approves, a fixed step applies.** The only other way to change data is a Run a tool step whose author ticked "This step may change data". The only way to send data outside the platform is a Call a connection or Send a message step whose author ticked "This step sends data outside".

## Parts

| Part | Where | What it does |
|---|---|---|
| List values | `supabase/migrations/20261116140000_workflow_list_values.sql`, `packages/worker/src/workflow/list-check.ts`, `packages/mcp-server/src/tools/list-tools.ts` | Reading an attribute's list, holding proposed values to it, and adding a value |
| Service accounts | `supabase/migrations/20261116130000_workflow_service_accounts.sql` | Which user each client's steps run as, the Workflow Service role, and the checks on people |
| Who reviews | `supabase/migrations/20261117010000_workflow_review_routing.sql`, `apps/web/components/workflows/ReviewerPicker.tsx` | Who a review is for, keeping the starter apart, due dates, and reassigning |
| Review notices | `supabase/migrations/20261117020000_workflow_review_notices.sql`, `packages/worker/src/assistant.ts` | Telling people a review is waiting or overdue |
| Approvals, delivery | `supabase/migrations/20261117040000_workflow_review_approvals.sql`, `20261117050000_notification_delivery.sql`, `packages/worker/src/notify.ts` | More than one approval, handing an overdue review on, and sending notices by email and Slack |
| Stages | `supabase/migrations/20261119120000_workflow_stages.sql`, `packages/graphql/src/lib/workflow-screens.ts`, `apps/web/components/workflows/stages` | A step that shows one screen and waits, and the screens it can show |
| Checklist | `packages/graphql/src/lib/workflow-checklist.ts`, `apps/web/components/workflows/RunChecklist.tsx` | Every decision a run needs, numbered in order, and the screen for the open one |
| Step by step | `packages/graphql/src/lib/workflow-story.ts`, `packages/graphql/src/lib/workflow-step-detail.ts`, `apps/web/components/workflows/RunChecklist.tsx`, `apps/web/components/workflows/StepPane.tsx` | What each step of a run did, in a line and a few figures, what a step shows when it is opened, and what the run leaves open |
| Tasks | `packages/graphql/src/lib/workflow-tasks.ts`, `apps/web/lib/tasks.ts`, `apps/web/components/layout/TaskCenter.tsx` | The decisions waiting on you, counted once, in the top bar, the inbox, the sidebar and the tab |
| Forms, split runs, outbound | `supabase/migrations/20261117070000_workflow_forms_and_outbound.sql`, `packages/worker/src/workflow/outbound.ts`, `apps/web/app/portal` | Ask for information, the portal, one run per record, Call a connection, Send a message |
| Analytics | `supabase/migrations/20261117080000_workflow_analytics.sql`, `apps/web/app/workflows/analytics` | How each workflow is doing |
| Triggers | `supabase/migrations/20261117030000_workflow_triggers.sql`, `apps/web/components/workflows/WorkflowTriggers.tsx` | Starting a workflow when a feed event arrives or a data quality scan finds new failures |
| Tables and functions | `supabase/migrations/20261116120000_workflows.sql` | `ops.workflows`, `workflow_versions`, `workflow_runs`, `workflow_steps`, `workflow_events`, `workflow_reviews`, reached only through the `workflow_*` functions |
| Record filters | `packages/graphql/src/lib/workflow-filters.ts`, `packages/mcp-server/src/tools/selection-tools.ts` | The filters a run is started with, and the step that turns them into the records it works on |
| Blocks | `packages/graphql/src/lib/workflow-blocks.ts` | Steps that belong together, added to a workflow as one: the file import |
| Graph rules | `packages/graphql/src/lib/workflow-graph.ts` | Step types, what makes a graph sound, which step follows which, `{{placeholders}}` |
| Proposals | `packages/graphql/src/lib/workflow-proposal.ts` | What an agent proposes, the required-field check, a reviewer's decision |
| Templates | `packages/graphql/src/lib/workflow-templates.ts` | Starting points offered by New workflow |
| Engine | `packages/worker/src/workflow/engine.ts` | Walks a run through its graph, one recorded step at a time |
| Agent step | `packages/worker/src/workflow/agent.ts`, `claude.ts`, `gemini.ts` | The model loop and the two providers |
| Tools | `packages/worker/src/workflow/tools.ts` | The chat assistant's tools, run as a person |
| Borrower tools | `packages/mcp-server/src/tools/borrower-tools.ts`, `packages/graphql/src/lib/borrower-financials.ts`, `borrower-financials-store.ts` | Reading a borrower's statements, trends, covenants and certificate values, and recording a certificate value and the quarter's review notes |
| Reconciliation tools | `packages/mcp-server/src/tools/rec-tools.ts`, `packages/graphql/src/lib/rec-digest.ts`, `rec-actions.ts` | Reading a fund's NAV, position, and cash reconciliation, and recording decisions, cash pairs, adjustments, and notes |
| Filed report tools | `packages/mcp-server/src/tools/nav-report-tools.ts`, `packages/mcp-server/src/feeds/nav-report.ts`, `packages/graphql/src/lib/nav-breaks.ts` | Reading a stored 10-Q or annual report onto a fund's NAV statement, loading it, and summarizing the breaks. See [NAV_REPORTS.md](NAV_REPORTS.md) |
| Pack tables | `packages/mcp-server/src/feeds/pack-tables.ts` | Reading every table of a stored file, trying a mapping without writing, and loading one table |
| API | `packages/graphql/src/resolvers/workflows.ts` | Queries and mutations the pages use |
| Pages | `apps/web/app/workflows` | The list, the editor, and the run page with its review |

## Setting up

Workflows run on the job worker. See [JOBS.md](JOBS.md) for running it. On top of what the worker already needs:

| Setting | Needed for | Notes |
|---|---|---|
| `SUPABASE_ANON_KEY` | Any step that runs a tool | |
| A workflow service account for the client | Any step that runs a tool | See [who a step runs as](#who-a-step-runs-as) |
| `ANTHROPIC_API_KEY` | Agent steps on Claude | |
| `LLAMA_CLOUD_API_KEY` | Reading a scan, a picture or a Word file in a file step | See [Reading a whole file](#reading-a-whole-file) |
| `VOYAGE_API_KEY` | Searching a file's words by meaning | Without it `search_documents` finds by words only. See [DOCUMENTS.md](DOCUMENTS.md) |
| `GEMINI_API_KEY` | Agent steps set to Gemini | |
| `WORKFLOW_AGENT_MODEL` | Optional | Default `claude-opus-5-5` |
| `WORKFLOW_AGENT_EFFORT` | Optional | `low`, `medium`, `high` (default), `xhigh`, `max` |

A worker with no model key still runs workflows that have no agent step.

## Which records a run works on

**A workflow says what is done. A run says to which records.** No workflow names a fund, a type of record, or a filter of its own. The same Fund reconciliation runs for one fund, for three, or for all of them; the same Data cleanup runs for one record or for every record.

### Starting a run

Start run asks which records. It never assumes.

| From | What happens |
|---|---|
| **Workflows**, Start run | A picker opens. Find records by name or code and tick them, or choose all of them |
| **A record's page**, Run workflow | Lists the published workflows that run on that type of record. The one you pick opens with the record already chosen. You can add more |
| **The editor**, Try it | The same picker, for the version on screen |
| **A schedule** | The filters are in the schedule's `input`, as below |

Choosing all of them takes a second press: the button changes to "Yes, run on every fund" before anything starts. A workflow that needs records chosen does not offer it. The line above the buttons always says what the run will cover. Edit as JSON shows the input the choices produce, to change by hand.

### What a workflow says about itself

A workflow names no record, but its **Start step** says what it is about. Select the Start step in the editor to set:

| Setting | Effect |
|---|---|
| Type of record it runs on | Only records of that type are offered, the workflow appears under Run workflow on their pages, and a run given another type is refused. Blank means any type |
| A run must have records chosen | The workflow cannot be started on everything, from the picker, the API, or JSON |
| Also ask for | Other values a run needs, such as a period end. Each becomes a field in the picker, and steps read it as `{{input.key}}` |

This is not a filter. "Runs on funds" does not choose a fund.

A run started from a schedule is not checked against these settings yet. A schedule that names records of the wrong type selects nothing, and the run ends.

### The filters

A run is started with `filters` in its input, in the same shape for every workflow:

```json
{ "filters": { "domainCode": "FUND", "entityCodes": ["HSCF2", "HOCF1"], "nameContains": "" } }
```

| Filter | Keeps |
|---|---|
| `domainCode` | Records of this type |
| `entityCodes` | Records with these codes |
| `entityIds` | Records with these ids |
| `nameContains` | Records whose name contains this text |
| `limit` | At most this many. Default 100, at most 500 |

Every filter given must hold. Only active records are selected.

Every template starts with the same step, **Select records** (`find_records`), which turns the filters into a list. The steps after it read that list (`{{steps.select.entityIds}}`) and nothing else, and each agent is told to stay inside it.

Two cases are kept apart all the way down:

| The run was started with | Select records returns | The steps after it |
|---|---|---|
| No filters | `filtered: false` and no list | Are not restricted: they cover every record they apply to |
| Filters that match nothing | An empty list | Have nothing to do, and the run ends |

Select records also reports any code or id that matched nothing, and says when the filters match more records than the limit. A selected record a workflow does not apply to is left out and named: a position passed to Fund reconciliation is listed as not a fund.

An agent works through the selected records in one step, within its round limit, and everything it proposes goes to one review.

For a large selection, tick **One run per record** on the Start step. A run started on several records then starts one run for each record, up to 500, each with filters naming that record, and ends. Each run has its own agent pass and its own review, so reviewers approve record by record and one record's problem does not hold up the rest. The parent run's page lists them; each says it came from a split run. Records must be chosen: a run with no filters is refused.

The templates, all built this way:

| Template | What it does | Changes data |
|---|---|---|
| Data cleanup | Investigates open data quality exceptions and proposes fixes | After review |
| Fund reconciliation | Maps and loads administrator packs, reconciles, writes notes | After review |
| Required values check | Proposes missing required values. Needs filters | After review |
| Data quality brief | Briefs on open exceptions | No |
| NAV review | Names the checks and lines to look at before sign-off | No |
| NAV reconciliation | Takes a fund's filed report (a 10-Q, a 10-K) from a stored file to a summary of the breaks. It finds the fund from the report, loads it, reconciles and keeps the summary as notes on its own; a person is asked only to check a report it holds and to decide breaks. A `REPORT` trigger starts it when a report arrives. The summary covers the whole NAV pack ([NAV_PACK.md](NAV_PACK.md)). See [NAV_REPORTS.md](NAV_REPORTS.md) | Loads the report unless it is held; keeps the summary as notes; decisions after review |
| Borrower financials | Takes a borrower's quarterly statements through the file import block, tests the covenants against the borrower's certificate, and writes the quarter's review notes. Needs records chosen. See [Borrower financials](#borrower-financials) | After review |
| Cash tie-out | Says what ties to the bank and what does not | No |
| Closing readiness | Says whether each deal can close and what is open | No |
| Overcollateralization test, Single-name check | Score one compliance rule and explain the result | Stores the rule's results |
| File intake | Takes one stored file through mapping, staging, checks and promote as a guided run. See [Stages](#stages) | After a person approves the staged batch |

A compliance template fixes which rule it scores. That is what it does, not which records it is for: the rule is scored for every record it applies to, and the filters decide which records the brief covers.

When you build a workflow of your own, start it with Select records and give later steps `{{steps.select.entityIds}}`. Do not put a record, a type, or a filter in a step's settings.

## Building one

New workflow offers the templates. The editor is a canvas: add steps from the bar above it, drag from a step's right edge to connect it, and select a step to change its settings. The list under the canvas names everything that stops the graph being published.

- Every save is a new version. Versions are never changed.
- Publishing a version makes it the one new runs use. A run keeps the version it started on.
- Try it runs the version on screen without publishing it.
- A workflow runs each step once. There are no loops.
- **Split** starts every path leaving it. The paths go on side by side: a path waiting for a review or a form does not hold up the others. **Join** brings paths back together; it goes on once no path that could still reach it is running, so a path a Condition sent elsewhere is not waited for. A run waits when every path left is waiting, and finishes when no path is left and one reached End. The worker still runs one step at a time; side by side means no path waits on another.
- **Compare** what is on screen with any version, under the editor: steps added, removed, renamed, or with changed settings, and connections added or removed. Where a step sits on the canvas is not a change.
- **Export** downloads the workflow as a file; **Import** on `/workflows` makes a new, unpublished workflow from one. This is how a workflow moves from one environment to another. People named on review and form steps are left out, since people differ between environments; roles are kept.

A step's settings can read the run's input and any earlier step's result: `{{input.limit}}`, `{{steps.scan.totalCount}}`. Which records a step works on comes from Select records, not from the input. A setting that is only a placeholder keeps its type, so a number stays a number. A setting whose value is missing is left out, and the tool uses its own default.

A Condition and a Human review have named outcomes (`true`/`false`, `approved`/`rejected`). Each connection leaving them says which outcome it follows.

## What an agent step can do

The step lists the tools the agent may read with. Only tools that read can be listed: names starting `get_`, `list_`, `search_`, `find_`, `preview_`, `analyze_`, `compare_`, `validate_`, `parse_`, and `query_data`. Every other tool changes data, and the editor and the engine both refuse to give one to an agent.

To change something the agent calls `propose_changes`. Each proposed change says:

- whether it creates, edits, or deletes, and on what
- the exact tool call that would do it
- how sure the agent is: confident, fairly sure, or unsure
- why, and the facts it relied on
- anything it could not establish, as a question for the reviewer, with its best guess offered as a suggestion

The step can limit which changes may be proposed ("Changes it can propose").

**What the reviewer sees.** The step can also list views the agent may put in front of its reviewer ("What it can show the reviewer"). With `show_reviewer` the agent names a view, the fund and period to show, the rows it relied on, and why the reviewer should look. The engine keeps only views the step allows, with only the settings each takes, at most six, and stores them with the proposal. The views are listed in `packages/graphql/src/lib/workflow-views.ts`:

| View | Shows |
|---|---|
| Cash reconciliation (`rec.cash`) | One fund's bank lines beside its book cash flows for a period, the lines the agent points at, and whether the two sides tie |
| NAV reconciliation (`rec.nav`) | One fund's reported and proposed NAV, and the review items the agent points at, with the administrator's figure, ours, the NAV effect and what is decided |

| Borrower financials (`fin.borrower`) | One borrower's quarter: each covenant with its limit, our calculation, the certificate and whether the two agree, and how the key lines moved, with the covenants and lines the agent points at marked |

Fund reconciliation's reconciling step may show the two reconciliation views, and Borrower financials' reviewing step the borrower view. A reconciliation view's component is in `apps/web/components/workflows/review-sections/RecSections.tsx`, and the borrower view's in `FinSections.tsx`.

**Required fields are checked by the engine, not left to the agent.** When a change creates a record, the engine reads what that record's template requires. Each required attribute the agent did not supply becomes a question on the change, marked "required for this type of record".

### Data quality checks

Give an agent step `get_data_quality_checks` and it can run every active data quality rule against a record as the record is now. This is the same evaluation the data quality page shows. Nothing is stored. It is different from `list_dq_exceptions`, which reads exceptions recorded earlier.

For one record it returns:

- the checks it fails, each with the rule, the value that failed, and why
- the checks it passes, with the rule, so a proposed value can be held to it
- failures a person has already accepted
- required attributes it is missing

The agent is told to use this three ways. A failing check is a reason to propose a change, and the change names the checks it clears. A proposed value must satisfy the rules for its attribute. And a failure a person has accepted is settled and is left alone.

In the review, a change that clears a check says so in the table, and its detail lists the rule codes. The agent's summary says how many checks each record fails, and which of those its proposals would and would not clear.

The checks are not run again after changes are applied. To see the effect, run the workflow again or open the record's data quality page.

### Values that come from a list

Many attributes take their value from a list. A proposed value, or a suggested one, has to be on that list. The check runs when the agent proposes, before anything is recorded:

| What the agent wrote | What happens |
|---|---|
| The code, the label, or a synonym of a list value, in any case | Stored as the code. The agent is told |
| Something not on the list | The change is not recorded. The agent is shown the list and asked to choose again |
| Something not on the list, in a change that depends on one adding it | It stands. The reviewer decides on both |

Sent back with the list, the agent picks the value that means the same thing and says in its reasons what it mapped from ("Consumer Goods" to Consumer Staples), or asks the reviewer with no suggestion. Deciding that two wordings mean the same is a judgement, so the agent makes it where the reviewer can see it; the engine only makes the certain matches.

When nothing on the list fits, the agent can propose **adding the value**, as two linked changes:

1. `add_attribute_list_value`: add the value to the list.
2. The change that sets it, marked as depending on the first.

They are applied in that order. If the first fails, the second is not attempted. In the review:

- The second cannot be approved without the first, unless the reviewer changes its value to one already on the list.
- A list is shared by every client, so **only a tenant admin can approve an addition**. Anyone else can reject it and choose an existing value.
- The agent is told to add sparingly, and never to fit one odd record.

The agent needs `get_attribute_list_values` among its tools to read a list, and `add_attribute_list_value` among the changes it can propose to add to one. The check itself runs either way.

## Reading a whole file

A workflow reads a file with the standard file loader, the one Load data uses (`packages/mcp-server/src/feeds/intake-file.ts`). It is not limited to spreadsheets:

| File | Read by |
|---|---|
| CSV, Excel, JSON | The table parsers, on the server |
| A short PDF with selectable text | The built-in reader, on the server |
| A filed report (a 10-Q, a 10-K) | The report reader, on the server, statement by statement |
| A scan, a picture of a page, a Word file, a long or table-heavy PDF | LlamaParse, when `LLAMA_CLOUD_API_KEY` is set |

A table is not the whole file. The figure a covenant turns on is often explained in a footnote: an add-back taken, cash netted, a quarter restated. So a file's words are kept as well as its tables, and an agent can read them:

| Tool | Gives |
|---|---|
| `get_position_file_tables` | The tables of a stored file, to map and load |
| `get_position_file_text` | Every page's words: paragraphs, tables, the notes under them and the footnotes. `find` returns only the passages that hold the words given, with their page. A PDF's own text is read on the server; a scan, a picture or a Word file is given as LlamaParse read it |
| `search_documents`, `get_document_section` | The same words found by meaning, once the file is kept as a document. Pass the file's `documentId` to search that file alone |
| `create_position_file_import` | Stores a file of any of the kinds above. A document is kept as a searchable document at once |

**Every file a workflow loads is kept as a searchable document.** `load_position_file_table` and `load_nav_report` index the file they load, and File intake indexes its file as its first step. A document is indexed as the file itself, every page of it; a spreadsheet as a rendering of its tables. Each chunk is embedded by the worker (`document.process`), so search by meaning follows a little after the load; `get_position_file_text` needs neither the worker nor the embedding service. How a file is read, kept and searched is in [DOCUMENTS.md](DOCUMENTS.md).

The agents that read files (Map the packs, Reconcile and write notes, Explain the breaks, Review trends and covenants) have these tools and are told to read the notes before relying on a figure that carries a footnote mark or a label such as adjusted, pro forma, restated or unaudited, and to quote the file's own words with the page.

## Fund reconciliation

The Fund reconciliation template takes each selected fund's administrator pack from a received file to reconciliation notes.

Start it with the funds to reconcile, or with no filters for every fund that has a close calendar:

```json
{ "filters": { "entityCodes": ["HSCF2"] }, "periodEnd": "" }
```

Leave `periodEnd` blank for the period each fund is now closing. The agents find each fund's pack among the files not yet loaded.

| Step | Kind | What it does |
|---|---|---|
| Select records | Fixed | Turns the run's filters into the list of funds |
| Funds in this run | Fixed | Reads where each selected fund's close stands, before anything is loaded |
| Any fund to reconcile? | Fixed | Ends the run if the selection holds no fund with a close calendar |
| Step | Kind | What it does |
|---|---|---|
| Files received | Fixed | Lists the newest stored files |
| Map the packs | Agent | For each fund, reads every table of its pack, maps each one, and tries the mapping without writing |
| Review the mapping | Human | One change per table: what it is, where each column goes, what the trial load counted |
| Load the packs | Fixed | Loads the approved tables and saves each mapping for next time |
| Closes after loading | Fixed | Reads where each close stands again |
| Reconcile and write notes | Agent | Fund by fund: works through cash, positions, and NAV; decides each open item; writes the notes |
| Review the reconciliation | Human | Approve, edit, or reject each decision, cash pair, adjustment, and the notes |
| Record the outcome | Fixed | Records what was approved |
| Where the closes stand now | Fixed | Reads each close a last time. This is the run's result |

### How a pack gets in

The workflow works on files already stored in Load data. A file arrives there one of two ways:

- **A feed** (see [FEEDS.md](FEEDS.md)). A file that fits its saved map loads on its own, and the workflow has nothing to map. A file that does not fit is stored for review, and the workflow maps it.
- **An upload** in Load data.

A mapping approved here is saved. The next pack with the same columns fits its map, so a feed loads it unattended and the workflow goes straight to reconciling.

### Mapping

A pack is usually a workbook with several tables. The agent sees all of them (`get_position_file_tables`), and proposes one `load_position_file_table` per table it wants loaded, with the as-of date and the source (`FUND_ADMIN` for the administrator's figures, `INTERNAL` for our own).

- Before it proposes, it tries each mapping with `preview_position_file_load`. Matching and value cleanup are the real ones; nothing is written. The proposal carries the counts.
- A mapping that names a column, record type, or attribute that does not exist is refused by name, in the trial and again at the load.
- A table that loads with rows refused is reported as a failed change, with the counts. Rows that did load stay loaded.
- Rejecting every table ends the run. Nothing is reconciled against a pack nobody approved.

### Reconciling

The agent reads the same reconciliation the pages draw (`get_nav_reconciliation`, `get_position_reconciliation`, `get_cash_reconciliation`). It does not recalculate anything. It explains differences and proposes:

| Change | Tool | Notes |
|---|---|---|
| A decision on a review item | `record_rec_decision` | Accept, adjust, or query the administrator. Adjust and query need a note. Refused on a certified period |
| A cash pair | `approve_cash_match` | A pair the rules propose keeps its rule and confidence. Any other is a manual match with its variance. Refused if either side is already paired |
| A cash adjustment | `post_cash_adjustment` | Needs a reason. The agent is told to post one only for a difference whose cause is established, never to clear a residual |
| The notes | `save_reconciliation_notes` | One per fund, applied after that fund's other changes |

Each change is checked against the reconciliation again when it is applied, so a change that no longer fits is refused instead of recorded. An approved decision or adjustment is signed in its note: "Approved by Ada Reviewer in workflow run …".

**No workflow signs off or certifies.** There is no tool for either. Both stay with a person on the reconciliation page.

### The notes

The notes are kept on the period's close record and shown on the fund's reconciliation page under Status to close. Sections: outcome, what was received, NAV, positions, cash, actions (who does what, and what it unblocks), and queries for the administrator, worded to send.

The agent writes the notes before the review, as the reconciliation will stand if everything is approved. A reviewer who rejects a change should edit the notes to match. As a check, the platform stores an outcome line beside the notes that it reads from the reconciliation itself when they are saved: breaks, undecided items, whether cash ties. The page shows both.

Saving notes again replaces them. Earlier versions stay in the close record's history.

### Setting up

- Apply `supabase/migrations/20261116160000_close_rec_notes.sql`. Without it everything runs except saving the notes, which fails and says so.
- The client's workflow service account needs to read and write the fund's records, which the Workflow Service role gives it.
- The worker needs `SUPABASE_SERVICE_ROLE_KEY` (it already does) for the file tools, which read stored files with it, inside the service account's client.

To run it on a schedule, queue `workflow.start` after the feed's poll:

```json
{ "workflowCode": "FUND_RECONCILIATION", "input": { "filters": { "entityCodes": ["HSCF2"] } } }
```

## Borrower financials

The Borrower financials template takes a borrower's quarterly financial statements from a received file to review notes. The run starts with the file, and the issuer is found from it. The file goes through the standard import, the covenants are tested, the borrower's certificate is set beside our calculation, and the quarter is written up.

Start it with the quarter, and hand it the file. It needs no records chosen:

```json
{ "periodEnd": "2026-09-30" }
```

Leave `periodEnd` blank for the latest quarter that has ended. A run takes one file, so start one run for each borrower.

**The issuer comes from the file.** `find_file_record` searches every value in the file that could be a name among the client's stored issuers, by code, name and alias, and scores each (an exact code is 1.0, an exact name 0.97, a known alias 0.94, a name apart from a suffix such as Inc or LLC 0.92). The file names an issuer when a value matches at 0.88 or more and no other issuer matches as well. Lesser matches are listed as candidates and are never used on their own. When no issuer is named surely, or two fit equally, the run asks a person on the Choose the record screen, which lists the candidates and searches all issuers. A person's choice is checked against the client's issuers before the run goes on.

| Step | Kind | What it does |
|---|---|---|
| Receive the file, Index for search | [File import](#the-file-import-block) | The statements are handed to the run or uploaded, and indexed for search |
| Find the issuer in the file | Fixed | `find_file_record`: searches the file's values among the stored issuers |
| Did the file name one issuer? | Fixed | Goes on when it did, and asks a person when it did not |
| Choose the issuer | Human | The Choose the record screen. Only when the file did not name one surely |
| Issuer | Fixed | Settles the issuer, the one the file named or the one the person chose. Later steps read it as `steps.select.entityIds` |
| Financials on file | Fixed | Reads the issuer's statements, covenants and certificate values as they stand, before anything is loaded |
| Any statements or deals on file? | Fixed | Ends the run if the issuer holds no record with statements or deals |
| Understand the file … Promote to live records | [File import](#the-file-import-block) | The rest of the import: confirmed, mapped, staged, checked and promoted. Each decision is on the loader's own screen |
| Recalculate the covenants | Fixed | Stores every covenant on the borrower's deals again from the lines now on file |
| Financials and covenants now | Fixed | Reads each borrower again |
| Review trends and covenants | Agent | Says how the lines moved and whether each covenant holds, reads the compliance certificate from the stored files and proposes each certified value, says why a certificate differs from our calculation, and writes the quarter's notes |
| Review the quarter | Human | Approve each certificate value, approve or edit the notes, and any correction the agent proposed |
| Keep the review | Fixed | Keeps what was approved |
| Where each borrower stands now | Fixed | Reads each borrower a last time. This is the run's result |

**No agent maps or loads the file.** A person does, on the mapping screen, with the file beside it. The agent's work starts once the lines are live: it reads, compares and writes.

Saying there is no file ends the run, because nothing says which issuer to review. Stopping the import part way (at the file, at the mapping, or by discarding the staged batch) ends the run: nothing is reviewed against a load nobody approved.

The compliance certificate is read as a document, not loaded as a table. Upload it in Load data or on the Receive a file screen so it is stored; the reviewing agent finds it among the stored files, reads the figures and their footnotes, and proposes each certified value for a person to approve.

### What the tools read and change

The tools are in `packages/mcp-server/src/tools/borrower-tools.ts`. They read through `packages/graphql/src/lib/borrower-financials-store.ts`, and the figures are lined up by `borrower-financials.ts`, which calculates nothing the platform calculates elsewhere: the lines come from the statement book (the attribute formulas), and a covenant's value, limit and status come from the covenant test ([COVENANTS.md](COVENANTS.md)).

| Tool | Reads or changes |
|---|---|
| `get_borrower_financials` | For each borrower and one quarter: the statement lines for the last quarters, each key line's move on the quarter and on the year with the sharp moves marked, every covenant on its deals tested under the deal's own definition (limit, calculated value, numerator and denominator, the definition's lines with what each read and counted after its cap, status, cushion, history), the certificate value and whether it agrees, the house definition's value, and what is open with who has it |
| `recalculate_borrower_covenants` | Stores each covenant again (`recalculate_covenant`). It changes no statement line, limit or definition |
| `record_borrower_covenant_value` | Files what the compliance certificate says a covenant was at a quarter end under the Borrower Compliance Certificate source. That source ranks behind the calculation, so the calculation stays the golden value and the two are compared |
| `save_borrower_review` | Keeps the notes on the quarter's statement (`STATEMENT_REVIEW_NOTES`), with a one-line outcome the platform reads from the figures when they are saved (`STATEMENT_REVIEW_OUTCOME`) |

Statement lines are loaded by the file import block, like any other file. A line that looks wrong is corrected with `submit_manual_override` only when a second source on file shows the right value.

**A certificate agrees** when it is within 2% of our calculation (`CERTIFICATE_TOLERANCE`). **A line moves sharply** at 15% on the year or 10% on the quarter for an amount, 3 points for a margin, and half a turn for a multiple (`NOTABLE`). A key line that repeats another (ending cash and cash) is read once.

**No workflow waives a covenant, cures one, or sends anything to a borrower.** The agents are told to say what a person has to decide. A covenant past its limit is listed under what is open, for the deal team.

### In the review

The agent can put a borrower's quarter in front of the reviewer (`fin.borrower`): five figures, each covenant with its limit, our calculation, the certificate, the difference, the cushion and where it stands, then how the lines moved. A covenant the certificate and our calculation put on different sides of the limit says so in red.

### Setting up

- Apply `supabase/migrations/20261123150000_statement_review_notes.sql`. Without it everything runs except keeping the notes, which fails and says so.
- Publish the template for the client: `npx tsx scripts/publish-file-intake.mts <client code> BORROWER_FINANCIALS`.
- Restart the worker after pulling this change, so it has the tools and the Receive a file screen.
- To try it, `docs/samples/borrower-financials` holds a made-up package for the Halyard Systems sample borrower, and says what to expect from it.

## Reviewing

A run that reaches a Human review step waits, for as long as it takes. On `/workflows`, a review you can decide shows under "Waiting for you", soonest due first. The ones waiting for someone else are one click below it, each saying why it is not yours.

### Who reviews

A Human review step says who may decide it:

| Setting | Effect |
|---|---|
| Who reviews | People, roles, or both. Only someone named, or holding a role named, in the run's client can decide it. Tick nobody for anyone who holds `workflow.review`. A shared workflow can name roles only. A setting can be a placeholder, such as `{{input.reviewer}}`, for a person chosen when the run starts |
| The person who started the run cannot review it | On by default. For a scheduled run, the starter is whoever created the schedule. Turn it off only for a client with one reviewer |
| Hours to review | Gives the review a due date. It shows as due, then overdue. When it passes, the reviewers are told once. Nothing is decided |
| Also tell when overdue | Roles whose holders are told too when the review passes its due date, so they can chase or reassign it |
| When it is overdue, hand it to those roles | The review is reassigned to the escalation roles when it passes its due date, as well as them being told |
| Approvals needed | How many different people must approve, 1 to 5. Each approves the same set of changes. Anyone who may decide can reject, and that ends the review. If a later approver changes what is approved, the count starts again from them. The review shows who has approved and how many more are needed |

The database holds every decision to these rules, in `ops.workflow_review_blocker`. The page and the API only show what it says, so the same reason appears on the review, in the list, and when a decision is refused: "You started this run, so someone else has to review it", or "This review is assigned to Operations lead". A tenant admin is held to them too.

When the review opens, each person it names is checked. Someone who does not hold `workflow.review` in the client, or who started the run when the step keeps them apart, is left off, and the run's history says who and why. If nobody named is left, the review is open to anyone who can review.

**Reassign** on an open review hands it to other people or roles, with a reason kept in the run's history. Anyone who manages the client's workflows can reassign, and so can anyone who could decide the review now, so a reviewer can pass it on. The same checks apply: a person must hold `workflow.review`, a role must grant it, and the starter cannot be given a review that keeps them apart.

A review opened before this was added keeps the rules it was opened under: open to anyone, and the starter may decide it.

### Telling people

**Your tasks.** A task is a decision in a run that you can act on now: a review you can decide, a form you can answer, a screen you can work. Each is one point on its run's checklist, however many changes it holds. `myTasks` counts them in one place (`packages/graphql/src/lib/workflow-tasks.ts`), so every place in the app shows the same number:

| Where | What it shows |
|---|---|
| **Tasks** in the top bar | How many tasks are yours, red when any is overdue. It opens the inbox |
| The inbox | Your tasks, overdue first, then the soonest due, then the longest waiting. Each says what it is, which workflow, its place on the run's checklist ("Decision 2 of 3"), what it holds, and when it is due. A task new since you last opened the inbox is marked New. A review whose every change is ready can be approved there. Below, the decisions you can see that someone else has to make |
| Workflows in the sidebar | The same count. When the tools are folded away, it shows on Tools |
| The browser tab | The count in front of the page title, "(3) Home" |
| A note in the corner | When a task arrives while you are in the app, unless you are already on its run. It closes itself after ten seconds |
| Needs you on the home page | Reviews, and now forms and screens |

A task opens its run on that decision (`/workflows/runs/<run>?decision=<step>`). The count is read every minute while the tab is in view, when you come back to it, and as soon as you finish a decision. It clears only when the work is done, not when the task is seen.

Nobody has to watch the list. A review is announced as a note in each person's assistant briefing (the Briefing chat), with a link to the run. It goes to whoever can decide the review, whether or not they follow anything or have turned the assistant on.

| When | Who is told |
|---|---|
| The review opens | Everyone who can decide it: the people and roles it is for, or everyone holding `workflow.review` when it is for anyone. Not the person who started the run when the step keeps them apart |
| It is reassigned | Everyone who can decide it now, except whoever reassigned it |
| It passes its due date | The same people, and everyone holding a role under "Also tell when overdue". Once per review |
| A form opens, or passes its due date | Everyone who can answer it: the people and roles it is for, or everyone holding `workflow.review` when it is for anyone. A form sent outside the firm is not announced here; the outsider gets its link |
| A screen opens, comes back with a reason, or passes its due date | Everyone who can work it, the same way |

On the home page, a review you can decide is under Needs you. An overdue one goes to the top, marked as when it was due.

**Email and Slack.** Under **Review notices** on `/workflows`, someone who manages workflows can also send each notice by email to the reviewer's sign-in address, and to one Slack channel by its incoming webhook. Email needs `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` on the worker, and `APP_URL` for full links. Only a `https://hooks.slack.com/` address is accepted, and it is never shown again once saved. Each notice queues `notify.deliver`, which records every send; a recipient already sent to is not sent to again, and a failed send is tried again.

The overdue notices come from the platform job `workflow.reviews_due`, on a schedule the migration creates (`WORKFLOW_REVIEWS_DUE`, every 15 minutes). The same job sends again any note that was not delivered in the last two weeks, to anyone still in that client and in no other. A note about a review, form or screen that has been finished since is not sent; `ops.workflow_notice_open` decides that, for the briefing, email and Slack alike. Each notice is also kept in the run's history.

A notice about a form or a screen links to its run on that decision. It is written by a trigger when the form or screen opens, in `supabase/migrations/20261121150000_workflow_step_notices.sql`; a notice that cannot be written is logged as a warning and never stops the run. `scripts/db-tests/workflow-notices.sql` checks all of it, and runs in CI with `npm run test:db`.

Underneath, a notice is an `ops.activity_events` row with `recipients` set, in `supabase/migrations/20261117020000_workflow_review_notices.sql`. Any other part of the platform can address a note to people the same way.

### Deciding

The review is laid out in the order a person decides. First what to do now, named by the change that is next. Then the first lines of the agent's own summary, with the rest a click away. Then where things stand: each view the agent asked you to look at, as a few figures. Then every proposed change.

A person who cannot decide the review reads the same page without the call to act and without the buttons. The run's banner says once who it is waiting on and why.

**Each kind of change has its own screen.** The changes are grouped by the tool they run (`apps/web/lib/review-sections.ts`), and the groups are decided in order, each a part of the review on the run's checklist:

| Section | Changes | What you see |
|---|---|---|
| Cash pairs | `approve_cash_match` | The bank transaction beside the book flows it settled, the difference and the dates. Change the flows to correct the pair |
| Cash adjustments | `post_cash_adjustment` | Book less bank before and after, with the side, amount and reason to edit |
| Reconciliation decisions | `record_rec_decision` | The review item by name, with the administrator's figure, ours, the difference and the NAV effect, and how big the difference is as a share of the figure and of the NAV. Then what the agent recommends, why, and what it checked. Then Accept, Adjust or Query, each saying what it does, with the agent's pick marked. The note is one line until it is opened. Adjust and Query need a note, and a note the agent wrote for another choice has to be rewritten first. The buttons say what they record: "Confirm: accept", "Leave it undecided" |
| Other changes | Any other tool | The general table. When a record has several changes, its rows sit under the record's name, said once. A column that would say the same on every row is left out |
| Certificate values | `record_borrower_covenant_value` | The covenant by name, with its limit, our calculation, the certificate's figure and the difference, and which side of the limit each falls. The figure and where it is in the certificate can be edited |
| Reconciliation notes | `save_reconciliation_notes` | The notes folded to their first paragraph, with the sections they cover, to read in full, edit, or compare with the notes kept now. A change you rejected for the same fund is named, so the notes can be made to match |
| Review notes | `save_borrower_review` | The quarter's notes, folded and edited the same way as reconciliation notes, beside the notes kept now |

The rec sections read the fund's reconciliation with the same queries as the reconciliation page, at your As Of and Knowledge dates. A review of only other changes keeps the one table. Each rec card shows the agent's reasons and the first three things it checked; **See the exact change** opens the tool call it will run, and a required question opens it. A review item a card decides is not repeated in the view above it.

- **Approve the confident ones together** with one button.
- **Walk through the rest.** Each opens to show exactly what will happen, why, what it is based on, and its questions. Answer, or take the agent's suggestion, then approve or reject and move to the next.
- A change cannot be approved while a required question is open.
- Apply is enabled once every change has a decision.

Approving records the decision and the run continues down its `approved` path. Rejecting everything, or approving nothing, takes the `rejected` path.

## Asking for information

**Ask for information** puts a form in front of a person and waits. A field is text, long text, number, date, a choice, or yes or no, and can be required. Later steps read the answers as `{{steps.<step>.answers.<key>}}`. The step has two outcomes, submitted and declined; a decline needs a note.

| Who answers | How |
|---|---|
| People or roles in the client | The form shows under Forms waiting on `/workflows` and on the run's page, for those people. Blank means anyone with `workflow.review` |
| Someone outside the firm | A private link to `/portal/<token>`, emailed to the address the step names when the worker can send email. Otherwise the link is kept in the run's history for someone in the firm to pass on. Someone who manages workflows can also answer for them |

The portal needs no sign-in: the link is the key. Its token is random, only its SHA-256 is stored, it expires in 14 days, and it stops working once the form is answered. It shows the form's title, instructions, fields, due date, and the client's name, and nothing else. Answers are checked against the fields in the page and again in the database. Cancelling the run closes its forms.

## Stages

A **Stage** step puts one screen in front of a person and waits until they leave it. A Human review always shows a table of proposed changes and a form always shows fields; a stage shows whatever the work needs: a file beside its mapping, a staged batch with its checks. A workflow that passes through several stages reads as one guided piece of work.

| Setting | Effect |
|---|---|
| Screen | Which screen the person sees. The screen decides the step's outcomes |
| Title, What to do | Shown above the screen. Placeholders are filled from the run |
| The screen's own values | What the run gives the screen, such as the file or the batch, usually as a placeholder |
| Who works it, Hours to finish | As on a form. Blank means anyone with `workflow.review` |

Later steps read what the person left as `{{steps.<step>.result.<key>}}`, and each connection leaving the step follows one of the screen's outcomes.

### The screens

| Screen | Shows | Outcomes | Before the run goes on |
|---|---|---|---|
| Receive a file (`load.receive`) | What the run expects, the files stored in Load data with those naming the run's records first and where each stands (not loaded yet, loaded on a date, failed), an upload control, and the chosen file as it is | `received`, `none` | Received: the file is still stored |
| Choose the record a file is about (`intake.record`) | A stored file beside the records of one type it resembles, best first, with how surely each was found, and a search of all records of the type | `chosen`, `none` | Chosen: the record is a stored record of the type |
| Understand a file (`intake.understand`) | A stored file beside what was found in it: the kind of file, its tables, the records it holds, the record it is about, and whether it is indexed for search | `confirmed`, `abandoned` | Confirmed: the selected table has rows |
| Map a file (`load.map`) | A stored file beside where each column goes, the as-of date, and a dry run | `confirmed`, `abandoned` | Confirmed: the file has an as-of date and a column that identifies each record |
| Check staged values (`load.quality`) | A staged batch with its data quality checks, and corrections | `approved`, `discarded` | Approved: the batch is still staged, and no critical check fails because of it unless a reason was given. Approving needs `load.promote` |
| Check a filed report (`nav.report`) | A stored 10-Q or annual report the run held: why it was held, the fund to choose when the report names none on file, and how it maps onto the fund's NAV statement: each line at both dates and the report lines behind it, the lines left out and why, the schedule of investments, the report's own checks, and a trial load | `confirmed`, `abandoned` | Confirmed: the report has a fund and maps onto the NAV statement at its period end |

A value a screen can work without is marked optional (`optional` on the screen's value), and a step may leave it blank: Receive a file needs what the run expects, and takes the run's records when the workflow selects any.

A stage that was left with a file shows that file again whenever its decision is opened on the run's page, so the file a run worked on can be looked at from the run at any time.

**The engine checks, not the page.** When a person leaves a stage, the engine asks a read-only tool whether what the screen requires is true. If it is not, the stage is handed back to the person with the reason, and the run waits on it again. So a stage cannot be passed by calling the API directly.

A permission a screen names for an outcome is held on the stage when it opens, and the database refuses that outcome from anyone who lacks it. This is how the person who approves a batch must hold `load.promote`, while the fixed step that then promotes it runs as the client's service account like any other step.

### Where a value was read

Each of the three screens has the file beside it (`apps/web/components/feeds/SourcePane.tsx`). Pointing at something marks where it sits:

| On the screen | Marks |
|---|---|
| A column name on the Understand or Map screen, or Show in file on a column that needs a decision | The column |
| Show in file on a failing check | The cell the failing value was read from |
| Show in document on an issue from the dry run | The cell, or the row |

A PDF or a picture is drawn as its page, with a box where the reader found the value; the box is as tight as the reader reported (the value, its row, or its table). Any other file is shown as the table that was read, with the cell, column or row highlighted. A page can be switched to its table. A file read without positions is shown as its table only.

### The checklist

Every run opens as a list of its steps with the decisions it needs from people numbered on it. A review, a form and a stage are each one decision. They are numbered in the order the run reaches them and ticked off as they are done, and the screen for the open one sits beside the list. The system's and the agent's own steps are on the same list, each with what it did (see [Step by step](#step-by-step)); **Decisions only** hides them. The design, every step's raw result and the history are on Details.

| On the list | Means |
|---|---|
| A number | A decision the run reaches whatever is chosen. "2 of 4 decisions done" counts these |
| A tick | Decided, with how and by whom: "Approved by Ada", "Confirmed by Ada" |
| A dash | Passed with nothing to decide, such as a review the agent proposed nothing for |
| Your move | Open, and yours. It is opened beside the list |
| Waiting on … | Open, and someone else's, with the reason it is not yours |
| A dashed circle, no number | Comes only on some choices: it sits on one way out of a decision not yet made. It is not counted in the total, and takes a number once the choice puts it on the path |

A way out of a step that goes straight to End (Abandoned, Rejected, a Condition that ends the run) stops the run; it is not counted as another route. Steps every route reaches are numbered even after an undecided choice. A run with no review, form or stage on its path says it needs no decisions.

**Inside a decision.** The open decision lists what is left to do on it, as its screen reports it, and ticks each part off as the person works: on Map a file, confirming where each column goes, the column that identifies each record, the as-of date, reviewing what the load will do, and choosing between records that matched more than one; on Understand a file, the kind of document, the table and the record it is about; on Check staged values, correcting what fails a critical check, then approving or discarding. A review reports how many of its changes are decided. A screen reports through `onProgress` on `StageScreenProps`; a new screen should report its own parts in the order it lays them out.

A review walks its changes one at a time, flagged ones first, and a change comes up only after the changes it depends on are decided.

The checklist is published to the assistant on the run's Overview tab, with each decision's number, state and parts, and the open stages and forms.

### Step by step

A person asked to decide something needs to see what the decision rests on. So the run's page lists every step on the run's path, in order, with what it did:

| On a step | Means |
|---|---|
| A line | What the step did, in one sentence: "Loaded the report onto the fund at 2026-06-30. Nothing needed a person first." |
| Figures | The few numbers that matter, coloured when they are good or need a look: "The report's own checks: 200 of 200 tie", "Values: nothing changed, all 2,468 were already on file" |
| Agent | The step was a model's. Its line is the first sentence of its own summary, with what it read and how much it proposed |
| A time | How long the step took |
| An amber line | The step failed and was retried before it finished, with the reason |
| Still to run | The run has not reached it. "Only on some choices" when it sits on one way out of a decision not yet made |

The line and figures are read from what the step stored when it finished, in `packages/graphql/src/lib/workflow-story.ts`. Each tool the templates run has its own wording there (`TOOL_TOLD`). A tool with none is read by a general rule: a sentence its result carries (`headline`, `note`, `message`), or how many rows it returned. **When you add a tool a workflow runs as a step, add its wording**, and prefer a result that carries a `headline` a person can read. Steps that only route the run (Start, End, Split, Join) are left out.

**What is open, and who has it.** A step can find things the run does not settle: a figure not on file, an input someone has to chase. When a step's result lists them (`entries`, each with a `title`, an `action` and an `owner`), the page shows the latest such list under the decision: the item, why it is open, the next step, who has it, and where it stands. An item a change in the run's open review decides is marked "Decided in this run"; one the step calls blocking is marked as holding up the close. NAV reconciliation's "Review the NAV" and "Where the NAV stands now" report this way.

The steps are one list, and **every step opens in place, under its own line**. The decision the run waits on is open to start with, showing its screen right there, so nobody scrolls past the list to act. The steps already done before it are folded into one line ("3 steps done before this decision") that unfolds, which keeps the open decision near the top of the page; fewer than three are simply listed. A closed step is one line: its name, what it did cut short, how long it took. "Decisions only" hides the system's and the agent's steps.

What a run found open is shown where it belongs, and nowhere else: under a review whose changes decide some of it, inside the step that found it once that step is opened, and under the list when the run is over.

The steps and the open items are published to the assistant on the Overview tab as `steps` and `stillOpen`, built by the same function the page draws from.

#### Opening a step

Every step in the list opens, whether or not it needs a person. A step that has nothing to decide still has to be checkable: the line on the list is a claim, and opening the step is how a person tests it. `stepDetail` in `packages/graphql/src/lib/workflow-step-detail.ts` builds what is shown, from the step's stored result and the run's history, so it works for runs already recorded.

| Section | Shows | For |
|---|---|---|
| What this step is | The kind of step in a sentence, the tool it runs, and whether it only reads or may change data | Every step |
| What it was asked | The settings the tool ran with, as recorded when it ran. For a step that has not run: its design, with each `{{placeholder}}` in words ("what “Select records” returned as entity ids") | Fixed steps |
| What it tested | The condition as a sentence, and the way out it took | Conditions |
| What it read | Each read the agent made, in order: the tool in words, what it asked for, and whether it worked | Agent steps |
| What it proposed | Each change, marked confident or flagged for a close look | Agent steps |
| Its write-up | The agent's full summary | Agent steps |
| The changes it made | Each approved change, made or not, with the reason when it was not | Apply steps |
| What it returned | The result as plain values, named groups of values, and each list as a table of its first rows with a count. Never raw JSON. Record ids are left out | Fixed steps |
| As it happened | The step's entries in the run's history, and for an agent how many model calls it made and about what they cost | Every step that ran |

A decision the run has reached opens its own screen. One it has not reached opens as a step and says what it will ask and of whom. Any number of steps can be open at once. Closing the line of an open decision hides its screen without discarding it: choices made on a review and not yet applied are kept.

Each step's opened detail is published to the assistant with the step, on the Overview tab: `whatItIs`, `askedWith` or `setUpWith`, `read`, `proposed`, `changesMade` and `returned`.

A change that carries a list of records, such as a file load's column mappings, shows the list as a table in the review. Column mappings read as the column in the file, where it goes (the attribute by its own name) and how it is read, with the columns left out named underneath.

### The file import block

**A workflow that takes a file uses the file import block. It does not map or load a file any other way.** The block is the standard import as a run of ordinary steps, so a workflow gets every part of it (the loader that reads any format, the searchable document, the mapping screen with the file beside it, saved maps, staging, the data quality checks, promotion) and the run's page shows each part as its own step.

`fileImportBlock` in `packages/graphql/src/lib/workflow-blocks.ts` builds it. In the editor, **Add a block, File import** adds it to the right of the selected step, already connected inside, with its ends left open for you to connect.

| Step | Kind | What it does |
|---|---|---|
| Receive the file | Human | The Receive a file screen: choose a stored file or upload one, look at it, hand it to the run. Left out when the run was started on a file |
| Index for search | Fixed | `index_position_file_import`: keeps the file as a searchable document. A file that cannot be indexed is noted and the run goes on |
| Understand the file | Human | The person confirms what the file is, which table to load, and the record it is about. The document is filed under that type and linked to that record |
| Map the file | Human | The mapping screen. Confirming saves the mapping and the date on the file |
| Stage the values | Fixed | `stage_position_file_import`: keeps what a load would do as a batch. Nothing is live |
| Was it staged? | Fixed | Leaves the block when nothing could be staged |
| Check the values | Human | The quality screen. Correct, then approve or discard |
| Promote to live records | Fixed | `promote_load_batch`, with the reason when a critical failure was approved |
| Discard the batch | Fixed | `discard_load_batch`, when the person discarded it |

The block has three kinds of open end, and the workflow says where each goes (`blockExits`):

| Open end | Leaves from | Usually goes to |
|---|---|---|
| Loaded | Promote to live records | The steps that use the new values |
| No file | Receive the file, when the person says there is none | The same steps, working on what is on file, or End |
| Stopped | Understand the file and Map the file when stopped, Was it staged? when nothing staged, Discard the batch | End |

Later steps read the file as `{{steps.<receive step>.result.importInstanceId}}` and its name as `…result.fileName`. A workflow can hold more than one import: the editor gives each block's steps their own ids (`import_file`, `import2_file`).

A block is not a new kind of step, so the engine, the checklist and the step list need nothing new for it. Each of its four screens is a numbered decision, and each fixed step opens to show what it did. Until the person has handed over a file, the decisions that follow are marked as coming only on some choices, because saying there is no file skips them.

### File intake

The File intake template is the file import block on one stored file, given as `importInstanceId`. It works on a file and not on records chosen by filters, so it has no Receive the file step. Every open end of the block goes to End.

Start it from Load data: **Guided intake** uploads a file and opens the run, and **Guided run** on a stored file's row does the same for a file already there. Both need the template published for the client under the code `FILE_INTAKE`. Staging, the checks and promote are described in [STAGING.md](STAGING.md).

## Sending outside the platform

Two fixed steps send data out. Each needs its author to tick **This step sends data outside**. Put them after a review when what is sent needs approving.

| Step | Sends |
|---|---|
| Call a connection | A GET, POST, PUT, or PATCH to one of the client's HTTP connections (set up under Load data), with its stored credential. The path is added to the connection's address and cannot leave it. https only, no private or internal hosts, no redirects, 30 seconds at most. The response is the step's result |
| Send a message | An email to up to 50 addresses, or a post to the client's Slack channel. The text is written from the run with placeholders. Email needs the worker's email settings |

## Analytics

`/workflows/analytics` shows, per workflow over the last 7, 30, 90, or 365 days: runs and how they finished, the typical and slowest-10% run time, how long reviews typically take, how many went overdue, the share of proposed changes approved, the three slowest steps with their failures, and the commonest failure.

## Who a step runs as

Every step runs as the client's **workflow service account**: a user that is not a person, belongs to that one client, and holds the Workflow Service role (`entity.read`, `entity.write`, `dq.manage`). What a workflow can read and change is what that account can. It cannot delete records or manage users, roles, or access. Give it another role if a workflow needs more.

The worker's own service key is not used for data. It cannot read the data schemas, and it would see every client at once. The worker uses it only to get the service account a session from Supabase Auth. No signing secret is kept, and no real person is ever signed in for.

People are checked by lookup before each call:

| Step | Person behind it | Must hold |
|---|---|---|
| Run a tool (reading), Agent | Who started the run. For a scheduled run, who created the schedule | `workflow.run` |
| Run a tool (changing data) | The same | `workflow.run` and `entity.write` |
| Apply approved changes | Who approved them | `workflow.review` and `entity.write` |

Who may approve in the first place is set on the review step. See [Who reviews](#who-reviews).

If the person does not hold these, the step fails and says why. So nobody approves a change they could not make themselves.

Two things follow from running as a shared account:

- **A workflow can read records its starter cannot.** If a person is restricted from some records, a workflow they start may still read them and show them in a proposal. Give `workflow.run` only to people you would trust with what the service account can see.
- **A record's own history shows the service account as the author.** Where the tool has a reason field, an approved change is signed there: "Approved by Ada Reviewer in workflow run …". The run's history always records who approved what.

### Setting up a client's service account

1. Create a user for it in Supabase Auth, with no password. Nobody signs in as it.
2. Add it to the client in `tenancy.client_users` and give it the `WORKFLOW_SERVICE` role in `tenancy.user_roles`. It must belong to no other client.
3. Register it: `select public.workflow_service_account_set('<client id>', '<user id>');`

## History

Every run keeps an append-only log: each step starting and finishing, each tool the agent called and with what, what it proposed, who decided the review and how, and each change applied or refused. The run page shows it beside the graph, filtered by system, agent, or person. Select a step on the graph to see only its entries, its settings, and its result.

## When things go wrong

- **A step fails.** The run is `FAILED` and names the step. Retry on the run page continues from that step. Steps before it are not run again.
- **The worker dies mid-run.** The job's lease expires and another worker takes the run. Finished steps are read back. An agent step continues from its last saved round.
- **The worker dies while applying a change.** That one change is reported as unconfirmed ("Check the record before applying it again") instead of being made a second time. The changes after it still run.
- **The worker dies while sending or writing.** A Call a connection step (other than GET), a Send a message step, or a Run a tool step that may change data is marked before the call. Found still marked after a restart, it fails with "it may already have happened" instead of sending again. Check, then Retry. Every attempt at one step sends the same `Idempotency-Key` (the run and step), so a connection or the email service that honours it does not act on a repeat.
- **A run is cancelled.** A step already running finishes; nothing after it starts. Changes already applied stay.

## Scheduling

Put a `workflow.start` job on a schedule at `/admin/jobs`:

```json
{ "workflowCode": "DATA_CLEANUP", "input": { "filters": { "domainCode": "FUND" }, "limit": 20 } }
```

It starts a run of the published version for the schedule's creator, who must hold `workflow.run`. If the run reaches a review, it waits there for a person like any other.

## Starting when something happens

A trigger starts a workflow when a feed event arrives, when a data quality scan finds new failures, when a rule is breached, when a value changes, or when a filed report arrives. Set one up under **Start automatically** on the workflow's page. It needs `workflow.manage` and `workflow.run`.

| Source | Starts when | Narrowed by |
|---|---|---|
| A data quality scan finds new failures | A `dq.scan` finds records that began failing a rule, or lost a required value, since the day before | Severity, rule codes, types of record |
| A feed does something | A feed loads a file, has one waiting for review, fails, or is late | Which of those, feed codes |
| A compliance rule is breached | A soft or hard breach where the result before it, for the same rule, record, and grouping, was not a breach | Rule codes, soft or hard |
| A value changes | A new current value is recorded for one of the attributes the trigger names | 1 to 20 attribute codes (required), types of record |
| A filed report arrives | A stored file is read as a filed report (a 10-Q, a 10-K, an annual report), whether uploaded or brought by a feed or email | Entity names, each matched anywhere in the name the report gives |

Data quality is checked live, and the exceptions table holds only failures a person accepted. So "new" comes from the scan, which compares each record with the day before. Each `dq.scan` that finds something new records one `DQ_NEW_FAILURES` event listing those records (up to 500), with the rules they fail. Schedule the scan once a day: a second scan the same day reports the same new failures again.

Events are not acted on one at a time. Everything new since the trigger last fired goes into **one run**, up to 500 events or records. A scan that finds 300 records failing starts one run, not 300.

- **What the run covers.** A run started by data quality failures, a breach, or a value change is given those records as `filters.entityIds`, added to any filters in the trigger's input, so Select records picks them and nothing else. A record fits when one of its failing rules matches the trigger's severities and rule codes. A record that only lost a required value has no rule, so it fits only a trigger that names no severity or rule. A run started by a feed gets the trigger's input as it is, like a schedule's. A run started by a report gets one report, the earliest waiting, as `importInstanceId`, added to the trigger's input; the next report waits for the next run.
- **What started it.** Steps can read `{{input.trigger}}`: the trigger's name, its source, how many events or records there were, and up to 50 of them (the record, its rules and severities, and how many required values it lost; or the feed, file, and what happened).
- **One run at a time.** While a run a trigger started is queued, running, or waiting for a review, the trigger starts nothing. New events wait, and the next run takes all of them. The trigger's line on the page says so.
- **Who it runs as.** Runs start as whoever last saved the trigger, through the same `workflow.start` job a schedule uses, with the same checks. If that person can no longer run workflows, the start fails and the trigger shows why.
- **Only the published version runs.** A trigger on an unpublished workflow starts nothing.
- **Nothing earlier.** A new trigger acts only on what arrives after it is saved. Turning one back on does not act on what arrived while it was off.

Underneath, the platform job `workflow.triggers` does the matching. It is queued the moment a feed or scan event is written, and also runs every 5 minutes from the `WORKFLOW_TRIGGERS` schedule. Each trigger keeps a cursor of what it has acted on. The tables and functions are in `supabase/migrations/20261117030000_workflow_triggers.sql`, which also changes `job_run_dq_scan` to record the event. `supabase/migrations/20261122110000_report_trigger.sql` adds the `REPORT` source: a stored file whose intake method becomes `financial_report` records one `REPORT_RECEIVED` event.

## Permissions

| Permission | Lets a person |
|---|---|
| `workflow.manage` | Create, change, publish, and archive workflows |
| `workflow.run` | Start, cancel, and retry runs |
| `workflow.review` | Approve or reject proposed changes |

Client admins have all three. A person may belong to several clients. Any member of a client can see its workflows, runs, and reviews. A shared workflow (no client) can be run by every client and changed only by a tenant admin.

## Adding a template

Add an entry to `WORKFLOW_TEMPLATES` in `packages/graphql/src/lib/workflow-templates.ts`. The test in `workflow.test.ts` checks that every template is a sound graph.

## Not built yet

- Loops. A graph runs each step once. A stage can be handed back to the person, but a run cannot go back to an earlier stage.
- Stages for proposed new fields and a drafted template. Four screens exist: understanding a file, mapping it, checking staged values, and checking a filed report.
- Choosing the stored record a file's values load onto. The Understand screen links the document to a record; the loader still matches values by code, identifier and name.
- Starting a guided run when a file arrives by a feed. It is started by hand from Load data.
- Handing an overdue form or screen on to other roles. Reviews can be; forms and screens are only chased.
- Choosing how you are told: a digest, quiet hours, or browser notifications.
- Screens for more kinds of change. Reconciliation changes have their own; a proposed new field, list value, alias or template is still decided in the general table.
- Performance review. There is no read tool for returns or attribution, so no view or section for them.
- A card for a statement load in a borrower review. The mapping is decided in the general table, as it is for an administrator pack.
- Linking a file's document to the record a workflow loaded it for. File intake's Understand screen does; the other workflows leave the document unlinked, so an agent searches it by its `documentId`.
- A trigger that starts Borrower financials when a borrower's package arrives.
- Fund reconciliation still has an agent map its packs and propose each load (`load_position_file_table`). It has not been moved onto the file import block. A pack is several files and several tables, and the block takes one file and one table a run.
- A file import that takes several files in one run. Today it is one file a run, and a second file needs a second block or a second run.
- The checklist on the home page and in the hub. It is on the run's page.
- Steps on parallel paths running at the same moment. Paths do not wait on one another, but the worker runs one step at a time.
- A deal setup template. The engine supports it.
- Filtering by an attribute's value (every fund of one strategy). Filters are by type, code, id, and name.
- Run workflow on rows selected in a list. Lists have no row selection; it is on each record's page.
- Checking the notes against the reconciliation after a reviewer rejects a change. The stored outcome line is the check.
- Choosing an escalation role that does not grant `workflow.review`. The editor offers only roles that do, though the database accepts any.
- Approvals in a set order (first a preparer, then a checker). Approvals are counted, in any order.
- A form field that is a file upload.
- Promoting a workflow between environments in one step. Export and Import move it as a file.
- The demo briefs (morning quality, Halyard single-name, Brightwater close, Harbor NAV, CLO coverage, Halyard cash) only report. They are published for one client by `scripts/publish-bill-demo-workflows.mts`.
