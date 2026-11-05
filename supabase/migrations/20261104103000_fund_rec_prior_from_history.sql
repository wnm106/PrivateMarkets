-- Fund reconciliation reads a comparison from the prior certification.
-- The Halyard sample had stored those comparisons as extra attributes on the
-- current pack (a prior amount on each NAV line, and beginning balances on
-- the current roll-forward). Those figures are the same attributes, valid
-- through the prior period end. The open row stays the current period.

UPDATE metadata_register.attribute_register
SET description = 'Retired as a load for fund reconciliation. The prior amount is the administrator amount as of the prior certification.'
WHERE attribute_code = 'NAV_LINE_PRIOR';

UPDATE metadata_register.attribute_register
SET description = 'Retired as a load for fund reconciliation. The opening fair value is the position market value as of the prior certification.'
WHERE attribute_code = 'ROLL_BEGIN_FV';

UPDATE metadata_register.attribute_register
SET description = 'Retired as a load for fund reconciliation. The opening unrealized amount is the position unrealized gain as of the prior certification.'
WHERE attribute_code = 'ROLL_BEGIN_UNREALIZED';

UPDATE metadata_register.attribute_register
SET description = 'Retired as a load for fund reconciliation. The opening accrual is the position accrued interest as of the prior certification.'
WHERE attribute_code = 'ROLL_BEGIN_ACCRUED';

DELETE FROM golden_master.entity_attribute_values
WHERE metadata->>'fundRecLookback' = 'true';

-- Prior NAV amounts, valid through June 30, 2026. The open administrator row remains the current period.
INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
    valid_from, valid_to, system_from, precedence_rank, metadata
)
SELECT DISTINCT ON (me.id)
    me.id, admin_attr.id, prior_row.source_id, prior_row.golden_value,
    COALESCE(prior_row.golden_value_numeric, prior_row.golden_value::numeric),
    DATE '2020-01-01', DATE '2026-06-30', TIMESTAMPTZ '2026-06-30 23:59:59+00', prior_row.precedence_rank,
    '{"fundRecLookback":"true","attribute":"NAV_LINE_ADMINISTRATOR"}'::jsonb
FROM entity_instances.master_entities me
JOIN metadata_register.attribute_register prior_attr ON prior_attr.attribute_code = 'NAV_LINE_PRIOR'
JOIN golden_master.entity_attribute_values prior_row
  ON prior_row.entity_id = me.id
 AND prior_row.attribute_id = prior_attr.id
 AND prior_row.system_to >= TIMESTAMPTZ '9999-12-31'
 AND prior_row.golden_value IS NOT NULL
 AND prior_row.golden_value <> ''
JOIN metadata_register.attribute_register admin_attr ON admin_attr.attribute_code = 'NAV_LINE_ADMINISTRATOR'
WHERE me.entity_code LIKE 'HSCF2-LINE-%'
ORDER BY me.id, prior_row.system_from DESC;

-- Opening positional values, valid through the same prior period end.
INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
    valid_from, valid_to, system_from, precedence_rank, metadata
)
SELECT DISTINCT ON (pos.id, opening.attribute_code)
    pos.id, opening.id, begin_row.source_id, begin_row.golden_value,
    COALESCE(begin_row.golden_value_numeric, begin_row.golden_value::numeric),
    DATE '2020-01-01', DATE '2026-06-30', TIMESTAMPTZ '2026-06-30 23:59:59+00', begin_row.precedence_rank,
    jsonb_build_object('fundRecLookback', 'true', 'attribute', opening.attribute_code)
FROM entity_instances.entity_relationships rel
JOIN entity_instances.master_entities roll ON roll.id = rel.parent_entity_id
JOIN entity_instances.master_entities pos ON pos.id = rel.child_entity_id
JOIN metadata_register.attribute_register begin_attr
  ON begin_attr.attribute_code IN ('ROLL_BEGIN_FV', 'ROLL_BEGIN_ACCRUED', 'ROLL_BEGIN_UNREALIZED')
JOIN golden_master.entity_attribute_values begin_row
  ON begin_row.entity_id = roll.id
 AND begin_row.attribute_id = begin_attr.id
 AND begin_row.system_to >= TIMESTAMPTZ '9999-12-31'
 AND begin_row.golden_value IS NOT NULL
 AND begin_row.golden_value <> ''
JOIN metadata_register.attribute_register opening
  ON opening.attribute_code = CASE begin_attr.attribute_code
       WHEN 'ROLL_BEGIN_FV' THEN 'MARKET_VALUE'
       WHEN 'ROLL_BEGIN_ACCRUED' THEN 'ACCRUED_CASH_INTEREST_AMOUNT'
       ELSE 'UNREALIZED_GAIN_LOSS'
     END
WHERE rel.relationship_code = 'ROLL_POSITION'
  AND pos.entity_code LIKE 'HSCF2-POS-%'
ORDER BY pos.id, opening.attribute_code, begin_row.system_from DESC;

-- The open row is this period. It starts the day after the prior period end,
-- so a lookback to that date cannot land on it.
UPDATE golden_master.entity_attribute_values AS current
SET valid_from = DATE '2026-07-01'
FROM golden_master.entity_attribute_values AS prior
WHERE prior.metadata->>'fundRecLookback' = 'true'
  AND prior.entity_id = current.entity_id
  AND prior.attribute_id = current.attribute_id
  AND current.id <> prior.id
  AND current.valid_from < DATE '2026-07-01'
  AND current.valid_to >= DATE '2026-07-01';
