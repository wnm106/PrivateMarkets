-- Position quantity is stored as SHARE_QUANTITY (Share / Unit Quantity).
-- Market value was multiplying QUANTITY, which positions do not populate,
-- so the breakdown reported an empty quantity while the holding size was present.

UPDATE metadata_register.calc_definitions cd
SET expression = jsonb_set(
        cd.expression,
        '{args,0,ref}',
        '"SHARE_QUANTITY"'
    ),
    updated_at = NOW()
FROM metadata_register.attribute_register ar
WHERE ar.id = cd.attribute_id
  AND ar.attribute_code = 'MARKET_VALUE'
  AND cd.calc_kind = 'EXPRESSION'
  AND cd.expression #>> '{args,0,ref}' = 'QUANTITY';

UPDATE metadata_register.calc_inputs ci
SET attribute_code = 'SHARE_QUANTITY'
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ci.calc_definition_id = cd.id
  AND ar.attribute_code = 'MARKET_VALUE'
  AND ci.input_role = 'OPERAND'
  AND ci.attribute_code = 'QUANTITY';
