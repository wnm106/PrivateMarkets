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
| Tables and functions | `supabase/migrations/20261116120000_workflows.sql` | `ops.workflows`, `workflow_versions`, `workflow_runs`, `workflow_steps`, `workflow_events`, `workflow_reviews`, reached only through the `workflow_*` functions |
| Graph rules | `packages/graphql/src/lib/workflow-graph.ts` | Step types, what makes a graph sound, which step follows which, `{{placeholders}}` |
| Proposals | `packages/graphql/src/lib/workflow-proposal.ts` | What an agent proposes, the required-field check, a reviewer's decision |
| Templates | `packages/graphql/src/lib/workflow-templates.ts` | Starting points offered by New workflow |
| Engine | `packages/worker/src/workflow/engine.ts` | Walks a run through its graph, one recorded step at a time |
| Agent step | `packages/worker/src/workflow/agent.ts`, `claude.ts`, `gemini.ts` | The model loop and the two providers |
| Tools | `packages/worker/src/workflow/tools.ts` | The chat assistant's tools, run as a person |
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

## Building one

New workflow offers the templates. The editor is a canvas: add steps from the bar above it, drag from a step's right edge to connect it, and select a step to change its settings. The list under the canvas names everything that stops the graph being published.

- Every save is a new version. Versions are never changed.
- Publishing a version makes it the one new runs use. A run keeps the version it started on.
- Try it runs the version on screen without publishing it.
- A workflow runs each step once. There are no loops.

A step's settings can read the run's input and any earlier step's result: `{{input.limit}}`, `{{steps.scan.totalCount}}`. A setting that is only a placeholder keeps its type, so a number stays a number. A setting whose value is missing is left out, and the tool uses its own default.

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

## Reviewing

A run that reaches a Human review step waits, for as long as it takes. It shows under "Waiting for a person" on `/workflows`.

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
{ "workflowCode": "DATA_CLEANUP", "input": { "limit": 20 } }
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
- Reconciliation and deal setup templates. The engine supports them; only Data cleanup is written.
- Assigning a review to a named person, and telling them it is waiting.
- A time limit on a review.
