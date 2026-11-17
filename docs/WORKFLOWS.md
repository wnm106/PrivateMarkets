# Workflows

A workflow is a multi-step automation: find something, have an agent work on it, get a person's approval, make the change, report. Workflows, their runs, and the reviews waiting for a person are at `/workflows`.

Three kinds of step, drawn in three colours everywhere a workflow is shown:

| Kind | Steps | What it does |
|---|---|---|
| Fixed | Run a tool, Condition, Apply approved changes, Start, End | The same thing every run |
| Agent | Agent | A model reads with the tools the step lists and proposes changes. It has no tool that changes data |
| Human | Human review | The run stops until a person approves or rejects what was proposed |

The rule the engine keeps: **an agent proposes, a person approves, a fixed step applies.** The only other way to change data is a Run a tool step whose author ticked "This step may change data".

## Parts

| Part | Where | What it does |
|---|---|---|
| List values | `supabase/migrations/20261116140000_workflow_list_values.sql`, `packages/worker/src/workflow/list-check.ts`, `packages/mcp-server/src/tools/list-tools.ts` | Reading an attribute's list, holding proposed values to it, and adding a value |
| Service accounts | `supabase/migrations/20261116130000_workflow_service_accounts.sql` | Which user each client's steps run as, the Workflow Service role, and the checks on people |
| Who reviews | `supabase/migrations/20261117010000_workflow_review_routing.sql`, `apps/web/components/workflows/ReviewerPicker.tsx` | Who a review is for, keeping the starter apart, due dates, and reassigning |
| Tables and functions | `supabase/migrations/20261116120000_workflows.sql` | `ops.workflows`, `workflow_versions`, `workflow_runs`, `workflow_steps`, `workflow_events`, `workflow_reviews`, reached only through the `workflow_*` functions |
| Record filters | `packages/graphql/src/lib/workflow-filters.ts`, `packages/mcp-server/src/tools/selection-tools.ts` | The filters a run is started with, and the step that turns them into the records it works on |
| Graph rules | `packages/graphql/src/lib/workflow-graph.ts` | Step types, what makes a graph sound, which step follows which, `{{placeholders}}` |
| Proposals | `packages/graphql/src/lib/workflow-proposal.ts` | What an agent proposes, the required-field check, a reviewer's decision |
| Templates | `packages/graphql/src/lib/workflow-templates.ts` | Starting points offered by New workflow |
| Engine | `packages/worker/src/workflow/engine.ts` | Walks a run through its graph, one recorded step at a time |
| Agent step | `packages/worker/src/workflow/agent.ts`, `claude.ts`, `gemini.ts` | The model loop and the two providers |
| Tools | `packages/worker/src/workflow/tools.ts` | The chat assistant's tools, run as a person |
| Reconciliation tools | `packages/mcp-server/src/tools/rec-tools.ts`, `packages/graphql/src/lib/rec-digest.ts`, `rec-actions.ts` | Reading a fund's NAV, position, and cash reconciliation, and recording decisions, cash pairs, adjustments, and notes |
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

An agent works through the selected records in one step, within its round limit, and everything it proposes goes to one review. For a large selection, start several runs with narrower filters. A run does not yet split itself up.

The templates, all built this way:

| Template | What it does | Changes data |
|---|---|---|
| Data cleanup | Investigates open data quality exceptions and proposes fixes | After review |
| Fund reconciliation | Maps and loads administrator packs, reconciles, writes notes | After review |
| Required values check | Proposes missing required values. Needs filters | After review |
| Data quality brief | Briefs on open exceptions | No |
| NAV review | Names the checks and lines to look at before sign-off | No |
| Cash tie-out | Says what ties to the bank and what does not | No |
| Closing readiness | Says whether each deal can close and what is open | No |
| Overcollateralization test, Single-name check | Score one compliance rule and explain the result | Stores the rule's results |

A compliance template fixes which rule it scores. That is what it does, not which records it is for: the rule is scored for every record it applies to, and the filters decide which records the brief covers.

When you build a workflow of your own, start it with Select records and give later steps `{{steps.select.entityIds}}`. Do not put a record, a type, or a filter in a step's settings.

## Building one

New workflow offers the templates. The editor is a canvas: add steps from the bar above it, drag from a step's right edge to connect it, and select a step to change its settings. The list under the canvas names everything that stops the graph being published.

- Every save is a new version. Versions are never changed.
- Publishing a version makes it the one new runs use. A run keeps the version it started on.
- Try it runs the version on screen without publishing it.
- A workflow runs each step once. There are no loops.

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

## Reviewing

A run that reaches a Human review step waits, for as long as it takes. On `/workflows`, a review you can decide shows under "Waiting for you", soonest due first. The ones waiting for someone else are one click below it, each saying why it is not yours.

### Who reviews

A Human review step says who may decide it:

| Setting | Effect |
|---|---|
| Who reviews | People, roles, or both. Only someone named, or holding a role named, in the run's client can decide it. Tick nobody for anyone who holds `workflow.review`. A shared workflow can name roles only. A setting can be a placeholder, such as `{{input.reviewer}}`, for a person chosen when the run starts |
| The person who started the run cannot review it | On by default. For a scheduled run, the starter is whoever created the schedule. Turn it off only for a client with one reviewer |
| Hours to review | Gives the review a due date. It shows as due, then overdue. Nothing is decided or escalated when it passes |

The database holds every decision to these rules, in `ops.workflow_review_blocker`. The page and the API only show what it says, so the same reason appears on the review, in the list, and when a decision is refused: "You started this run, so someone else has to review it", or "This review is assigned to Operations lead". A tenant admin is held to them too.

When the review opens, each person it names is checked. Someone who does not hold `workflow.review` in the client, or who started the run when the step keeps them apart, is left off, and the run's history says who and why. If nobody named is left, the review is open to anyone who can review.

**Reassign** on an open review hands it to other people or roles, with a reason kept in the run's history. Anyone who manages the client's workflows can reassign, and so can anyone who could decide the review now, so a reviewer can pass it on. The same checks apply: a person must hold `workflow.review`, a role must grant it, and the starter cannot be given a review that keeps them apart.

A review opened before this was added keeps the rules it was opened under: open to anyone, and the starter may decide it.

### Deciding

The review shows the agent's own summary, then a table of every proposed change with the agent's confidence beside it.

- **Approve the confident ones together** with one button.
- **Walk through the rest.** Each opens to show exactly what will happen, why, what it is based on, and its questions. Answer, or take the agent's suggestion, then approve or reject and move to the next.
- A change cannot be approved while a required question is open.
- Apply is enabled once every change has a decision.

Approving records the decision and the run continues down its `approved` path. Rejecting everything, or approving nothing, takes the `rejected` path.

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
- **A run is cancelled.** A step already running finishes; nothing after it starts. Changes already applied stay.

## Scheduling

Put a `workflow.start` job on a schedule at `/admin/jobs`:

```json
{ "workflowCode": "DATA_CLEANUP", "input": { "filters": { "domainCode": "FUND" }, "limit": 20 } }
```

It starts a run of the published version for the schedule's creator, who must hold `workflow.run`. If the run reaches a review, it waits there for a person like any other.

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

- Loops and steps that run side by side. A graph is one path, each step once.
- A deal setup template. The engine supports it.
- Splitting a large selection into several runs, or one run per record. A run works through its whole selection in one pass.
- Filtering by an attribute's value (every fund of one strategy). Filters are by type, code, id, and name.
- Run workflow on rows selected in a list. Lists have no row selection; it is on each record's page.
- Checking the notes against the reconciliation after a reviewer rejects a change. The stored outcome line is the check.
- Telling a reviewer a review is waiting, by email or message. It shows in their list on `/workflows`.
- Escalating an overdue review. Overdue is shown, not acted on.
- More than one approval on a review (two people, or one after another).
