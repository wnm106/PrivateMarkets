-- The borrower's certificate ranks behind the calculated covenant value.
--
-- The certificate rows were stored at precedence 100, the same as the
-- calculated (DERIVED) rows, and the source was ranked 80. The golden stamp
-- already picks the calculation, but readers that rank rows by precedence
-- (golden_master.winning_attribute_values, used by the record form and the
-- golden record) saw a tie and could show the certificate instead.

UPDATE entity_instances.source_registry
SET precedence_rank = 110
WHERE source_code = 'BORROWER_CERTIFICATE';

UPDATE golden_master.entity_attribute_values eav
SET precedence_rank = 110
FROM entity_instances.source_registry sr
WHERE sr.id = eav.source_id
  AND sr.source_code = 'BORROWER_CERTIFICATE'
  AND eav.precedence_rank < 110;
