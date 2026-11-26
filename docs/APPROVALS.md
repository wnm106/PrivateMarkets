# Four eyes: approvals for manual values and workflow reviews

A client can require a second person to approve changes made by hand. Staff turn it on per client under Admin, Clients, Users & Roles, Authentication ("Require a second person to approve manual values and workflow reviews"). It is the `tenancy.clients.four_eyes_required` flag, so no code names a client.

Migration: `supabase/migrations/20261126120000_four_eyes_approvals.sql`. Tests: `supabase/tests/20_four_eyes.sql`.

## Manual values

| | Without four eyes | With four eyes |
|---|---|---|
| Someone enters a manual value (record screen, data quality, assistant, Excel) | Written at once | Filed as a request. Nothing changes until it is approved |
| Who approves | | Someone else with `override.approve` and write access to the record. Client administrators and data stewards hold it by default |
| The person who entered it | | Can withdraw it, never approve it |
| Approving | | Writes the value from its effective date, signed by the approver |

- **One rule, on the ledger.** `entity_instances.enforce_attribute_value_client`, the trigger every value already passes, refuses a signed-in person's new manual value in a four-eyes client with SQLSTATE `FE001`. A direct insert or a call to `golden_master.write_value` cannot get around it.
- **One entry point.** `golden_master.submit_manual_override` writes the value, or catches `FE001` and files `golden_master.override_requests`. `writeManualOverride` in `packages/graphql/src/lib/source-write.ts` calls it, so the record screen, data quality, the assistant and Excel all follow the rule. Each tells the person the value was sent for approval.
- **Deciding.** `golden_master.decide_override_request` and `golden_master.withdraw_override_request`. `golden_master.override_requests_list` says for each request whether the caller can decide it, and why not.
- **Not blocked:** the platform service (a workflow applies what its own review step approved), and `write_value` writing again the earlier and later parts of a manual value it replaces.
- **Audit.** Requests are in `tenancy.audit_log` with every status change.

The **Approvals** screen (`/approvals`, under Tools) lists requests: Waiting, Decided, or Everything.

## Workflow reviews

A review step can already require a reviewer other than the person who started the run (`separate_reviewer`). In a four-eyes client it cannot be turned off: a trigger on `ops.workflow_reviews` sets it, and turning the flag on sets it on open reviews too.

## Not covered yet

- Other ways to write a manual value are refused in a four-eyes client rather than filed for approval: the reconciliation override, the attribute panel's "override" source edit, splitting a manual value, and clearing a manual value that started before the date it is cleared from. Each says the value needs approval.
- Approvers are not notified; they see the count on the Approvals screen.
- Workflow runs started by a trigger have no person who started them, so any reviewer may review them.
