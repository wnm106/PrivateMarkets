# Performance audit (2026-11-27)

Evidence: live `pg_stat_statements` / catalog stats since 2026-11-25 (read-only),
plus a replica built from migrations at roughly live scale. Stats include
migration replays and a backfill, so totals lean high.

## Done in this change
| Change | Proof |
|---|---|
| `20261127100000_rls_set_based_scoping.sql`: 17 schema-table read policies decide the caller once per statement, not per row (`domain_types` 34ms -> 1.7ms for 60 rows locally) | Rows visible to 7 caller states (member x2, no-membership, admin, admin without MFA, impersonating admin, curated catalog) across 18 objects are byte-identical before and after |
| `20261127100100_perf_indexes_and_autovacuum.sql`: drops `idx_eav_current_valid` (prefix of another index) and `idx_eav_entity_attr_prec` (0 scans); `(relationship_code, parent/child)` indexes; autovacuum for churn-heavy tables; `compliance.resolve_rule_versions` (set form, calls the one-rule function) | Batch function equals per-rule results; planner uses the new index |
| `ruleVersionsAt`: one request instead of one per rule (falls back until the migration is applied) | typecheck, tests |
| `performance-store.walkPages`: one request when the walk fits one page (was four identical walks) | `performance.test.ts`, `deal-performance-store.test.ts` |
| `fund-surface`: nine independent link reads run together | typecheck |
| `middleware`: public images skip the Auth call and sign-in decision | typecheck |
| `view-context`: `usePublishTabs` notifies listeners once per publish, not once per tab; FundSurface and FundRec memoise tab payloads | web test suite (472 pass) |
| Sidebar: entity types cached 5 min (read fresh on /admin); counts and exceptions still read on every navigation | typecheck |

## Not done, and why
- `entity_master` page-then-hydrate RPC and GraphQL column selection (largest DB total, ~5,000s): changes the shape the whole app reads; needs a decision and a JSON-diff harness.
- `entity_relationships` policy: a set-based rewrite returned identical rows but was not faster on the replica, so it was not shipped. The reviewer's attribution of the 4.79B-tuple scans to this policy is unproven; measure under the `authenticated` role in production first.
- Capacity `observe()` memoisation/concurrency, `proforma_snapshot` through `deal_score_plans`, `period_returns` cache, `data_quality_dashboard` cache: need the parity suite on real data and freshness proofs.
- AG Grid module trimming / lazy load, `autoHeight` default, ChatPanel/katex lazy load, `loading.tsx`, polling gates: need browser acceptance at 1440x900 and 1920x1080.
- Auth: local JWT verification and a short session-keyed decision cache: security-sensitive.
- `idx_eav_match_key` (18MB, 0 scans) is not defined in any migration (created out of band); left alone.
- `VACUUM FULL`/`TRUNCATE` on `load_batch_values` (253MB, 0 live rows) and `import_rows` (112MB, 200 rows): operational, run in a quiet window.
