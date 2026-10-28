-- Market capitalization is an amount. Grouped issuer rows should add it up.
UPDATE metadata_register.attribute_register
SET aggregation_type = 'SUM'
WHERE attribute_code = 'MARKET_CAP'
  AND COALESCE(aggregation_type, 'NONE') = 'NONE';
