# Certification: a close date for knowledge

When someone certifies a process (a fund's NAV close, a deal's allocation), the page they certified must keep showing what they certified, however the data changes later. The platform does this with the bi-temporal ledger instead of copying data:

- The database records the exact instant of certification (`knowledge_at`) together with the As Of date the page was read at.
- From then on, the page reads at that As Of date and that knowledge instant. Later loads, corrections and restatements are kept in the ledger with a later `system_from`, so the certified page does not see them.
- The key figures the person saw are stored with the certification. Every later read is compared with them, so a change the ledger cannot hold back (see [Limits](#limits)) is shown instead of slipping through.

## The records

`golden_master.certification_processes` lists what can be certified. A new surface that certifies adds a row; no code lists processes.

| code | label | has_period | subject record |
|---|---|---|---|
| `FUND_CLOSE` | NAV close | yes | the `FUND_CLOSE` record |
| `DEAL_ALLOCATION` | Deal allocation | no | the deal |

`golden_master.certifications` holds one row for each certification: the process, the subject record, the period end (when the process has one), `as_of_date`, `knowledge_at`, `figures`, `fingerprint`, a note, who certified it and when, `version`, `supersedes_id` and `depends_on`. Access follows the subject record (`tenancy.has_entity_access`).

- `golden_master.certify(process, subject, as_of, period_end, figures, note, depends_on)` stamps `knowledge_at = now()`. A caller cannot choose the instant. It fails if a certification is already active for the same subject and period.
- `golden_master.revoke_certification(id, reason)` reopens. A reason is required. The row is kept, with who reopened it, when and why.
- `golden_master.certification_at(process, subject, period_end, knowledge)` returns the certification in force at a knowledge instant. A certification is in force from `certified_at` until it is revoked.
- Rows are append-only. A trigger refuses every change except a single revoke, and refuses deletes, including from the service role.

GraphQL: `certification(processCode, subjectEntityId, periodEnd)`, `certificationHistory(subjectEntityId, processCode)`, `certify(input)` and `revokeCertification(id, reason)`.

## Re-certifying

Financial closes roll forward: a correction to a prior month end arrives later, dated in that month. Re-certifying reads the same As Of date with later knowledge.

1. **Reopen, with a reason.** The certification is revoked and kept. The page stops showing what was certified. It now reads the reopened version's As Of date as known now, and the banner shows which figures differ from that version.
2. **Fix and re-certify.** The new certification replaces the reopened one: `version` is one higher and `supersedes_id` points to it. It keeps the reopened version's As Of date. The database refuses a different As Of date, because a re-certification rolls knowledge forward, not the As Of date.
3. **Every version stays.** The banner lists them, each with its As Of date, knowledge instant, who certified it, and when and why it was reopened.

**Prior periods.** A close compares with the prior period as certified: at the exact knowledge instant of the prior period's certification that was in force at the close's own knowledge. This has two effects:
- An open close picks up a re-certified prior period.
- A close that is already certified keeps comparing with the version it was certified against, because its pinned knowledge comes before the re-certification.

The close records that prior certification in `depends_on`. When the prior version is later reopened, the close's banner says so. The close stays as certified, and the change goes into the next open period as a prior-period adjustment, unless someone reopens the close to re-certify it.

## Pinning a surface

Code: `apps/web/lib/certification.ts` and `apps/web/components/certification/CertificationScope.tsx`.

```tsx
const scope = useCertification({ processCode: 'MY_PROCESS', subjectEntityId, periodEnd });
const { asOfDate, knowledgeDate } = scope.dates;     // use these for every load
// ...load with knowledgeDate (a day, or an exact instant when pinned)

return (
  <SurfaceDatesProvider value={scope.dates}>
    <CertifiedBanner scope={scope} figures={myFigures(loaded)} />
    {/* tabs: read dates with useSurfaceDates(), not the global store */}
  </SurfaceDatesProvider>
);
```

1. **Read the certification before the first load.** Wait for `scope.ready`, so the page does not first draw at the wrong dates.
2. **Load at `scope.dates`.** When a certification is active, these are its `asOfDate` and `knowledgeAt`. Otherwise they are the user's dates. Pass the knowledge date to every query; the GraphQL `DateTime` arguments accept an exact instant.
3. **Tabs read `useSurfaceDates()`.** A tab component that reads the global store does not follow the pin.
4. **Build figures the same way at certification and on every later read.** Leave out status that certifying itself changes (certified flags, health, steps done), or the certified read will never match.
5. **Certify only the saved state, as known now.** `certifyBlockedBy(userKnowledge)` refuses to certify while the user is browsing at an earlier Knowledge date. Write any records the certification depends on (a certified flag) before calling `scope.certify(figures, { dependsOn })`, so the stamped instant already includes them. After a reopen, `scope.dates.asOfDate` is the reopened version's As Of date, and `scope.certify` leaves the As Of date to the database.
6. **Close edits while certified.** The server refuses writes to a certified subject (for example, `commitAllocation`), and the page disables them. Reopen with `<ReopenButton onReopen={(reason) => ...}>`, which asks for the reason, and revoke the certification first.
7. **Publish it to the assistant.** Add the certification (who, when, `asOfDate`, `knowledgeAt`, which view is showing) to the tab data. `useCertification` also sets `pinnedDates` in the store, so the assistant's tool calls read at the same instant ([SURFACE_TABS.md](SURFACE_TABS.md)).

The banner lets the person switch between **Certified** (pinned) and **Current data**. In the certified view, figures that differ from the stored ones mean the replay no longer matches. In the current view, they are what changed since.

## Where it is used

- **Fund reconciliation** (`components/fund-rec/FundRecWorkspace.tsx`). Certify NAV marks the close records, then certifies on the `FUND_CLOSE` record for the period. Reopen revokes, then clears the marks. A close certified before certifications existed shows a "Certified, but not pinned" notice and can be recorded; it is then pinned at the time it is recorded, not the original time.
- **Deal allocation** (`components/allocation/AllocationBoard.tsx`). Certify allocation is enabled once the saved book is on screen. The preview, the saved-book compliance score and every deal tab that reads dates follow the pin.

## Limits

The pin holds back everything stored in the dated ledger: attribute values and relationships. It cannot hold back:

- Records changed in place outside the ledger, such as a source's precedence rank, a fund marked inactive, or a reference list.
- Changes to calculation code, such as the allocation engine or the reconciliation rules.
- The Hypo run and an edited (what-if) compliance score, which always read as known now.

The stored figures are the backstop. If any of these changes what a certified page shows, the banner lists each figure that no longer matches what was certified.
