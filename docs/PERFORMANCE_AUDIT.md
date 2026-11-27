# Performance audit (2026-11-27)

Evidence: live `pg_stat_statements` / catalog stats since 2026-11-25 (read-only),
plus a replica built from migrations at roughly live scale. Stats include
migration replays and a backfill, so totals lean high.

## Done in this change
| Change | Proof |
|---|---|
| `20261127200000_rls_set_based_scoping.sql`: 17 schema-table read policies decide the caller once per statement, not per row (`domain_types` 34ms -> 1.7ms for 60 rows locally) | Rows visible to 7 caller states (member x2, no-membership, admin, admin without MFA, impersonating admin, curated catalog) across 18 objects are byte-identical before and after |
| `20261127200100_perf_indexes_and_autovacuum.sql`: drops `idx_eav_current_valid` (prefix of another index) and `idx_eav_entity_attr_prec` (0 scans); `(relationship_code, parent/child)` indexes; autovacuum for churn-heavy tables; `compliance.resolve_rule_versions` (set form, calls the one-rule function) | Batch function equals per-rule results; planner uses the new index |
| `ruleVersionsAt`: one request instead of one per rule (falls back until the migration is applied) | typecheck, tests |
| `performance-store.walkPages`: one request when the walk fits one page (was four identical walks) | `performance.test.ts`, `deal-performance-store.test.ts` |
| `fund-surface`: nine independent link reads run together | typecheck |
| `middleware`: public images skip the Auth call and sign-in decision | typecheck |
| `view-context`: `usePublishTabs` notifies listeners once per publish, not once per tab; FundSurface and FundRec memoise tab payloads | web test suite (472 pass) |
| Sidebar: entity types cached 5 min (read fresh on /admin); counts and exceptions still read on every navigation | typecheck |

## Second pass
| Change | Proof |
|---|---|
| `20261127210000_entity_master_page_before_hydrate.sql`: the attribute object is a per-record scalar subquery instead of an outer GROUP BY, plus a `(domain_code, entity_name) WHERE is_active` index. A 20-row page went 5.2s -> 0.32s, the count 1.45s -> 26ms (replica at live scale) | Every column of `public.entity_master` for 3 callers hashes identically before and after (relationship arrays sorted). Production's view text was checked to be the one replaced |
| Middleware: identity from `getClaims()` (local signature check with asymmetric keys, falls back to Auth); "allowed" sign-in decisions remembered 30s per access-token hash (`lib/sign-in-cache.ts`); refused, MFA-owed and unchecked are never remembered | `sign-in-cache.test.ts`; production `current_sign_in_decision` is STABLE and writes nothing |
| GraphQL request context: identity from `getClaims(token)`, fallback `getUser` | `request-context.test.ts`; resolvers read only `user.id` and `user.email` |
| Layout and page loaders (`loadSurfaceUser`, `loadModuleScope`, `loadAppNav`) wrapped in `React.cache`: one Auth call and one call to each tenancy function per render | typecheck |
| Capacity rank walks: identical probes answered once per read; lines walked 3 at a time | allocation, capacity and deal tests; each probe is one transaction, so parallel probes do not see each other's rows |
| Polling screens (workflows, run, documents, document, jobs) pause while the browser tab is hidden and refresh on return | web test suite |

## Production is ahead of the repo
Production has 34 migrations, from `20261124140000_client_catalog_tree` to
`20261127100000_score_rules_once_over_funds`, that are on no branch. This change's
migrations are numbered after them. Before they are pushed, those 34 should be
committed, because a replay from the repo no longer builds what production runs
(for example, production's EAV has `client_id` and a client-based read policy).
The functions these migrations touch were compared with production:
`schema_row_visible`, `domain_in_scope` and `catalog_restricted` have the same logic,
and the `entity_master` view is the same text.

## Not done, and why
- `entity_relationships` policy: a set-based rewrite returned identical rows but was not faster on the replica, so it was not shipped. The reviewer's attribution of the 4.79B-tuple scans to this policy is unproven; measure under the `authenticated` role in production first.
- `proforma_snapshot` / `score_deal_funds`: production already changed these (`score_only_rules_with_a_threshold`, `score_rules_once_over_funds`, `capacity_probe_first`) in migrations that are not in the repo. Redefining them from the repo would undo that work.
- `period_returns` and `data_quality_dashboard` caches: a cache keyed on inputs needs a proven freshness signal; a stale figure would silently change results.
- AG Grid module trimming / lazy load, `autoHeight` default, ChatPanel/katex lazy load, `loading.tsx`: change what renders, so they need the browser acceptance pass at 1440x900 and 1920x1080, which could not run here (no Supabase stack or app env in this container).
- `idx_eav_match_key` (18MB, 0 scans) is not defined in any migration (created out of band); left alone.
- `VACUUM FULL`/`TRUNCATE` on `load_batch_values` (253MB, 0 live rows) and `import_rows` (112MB, 200 rows): operational, run in a quiet window.
