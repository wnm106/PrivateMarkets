-- Dependent list fields.
-- A list value can sit under a parent value in the same list, so one list holds a
-- whole taxonomy as a tree. A field takes its choices from one level of that tree,
-- and names the field whose value narrows them. GICS is the first such list:
-- Sector > Industry Group > Industry > Sub-Industry on Issuer.

-- 1. Tree columns on list values
ALTER TABLE metadata_register.reference_list_values
    ADD COLUMN IF NOT EXISTS parent_value_id UUID REFERENCES metadata_register.reference_list_values(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS level SMALLINT;

CREATE INDEX IF NOT EXISTS idx_ref_list_values_parent
    ON metadata_register.reference_list_values(parent_value_id)
    WHERE parent_value_id IS NOT NULL;

COMMENT ON COLUMN metadata_register.reference_list_values.parent_value_id IS
'The value this one sits under, in the same list. Children of a value are the only valid choices below it.';
COMMENT ON COLUMN metadata_register.reference_list_values.level IS
'Depth in the list''s tree: 1 is the top. Null for flat lists.';

-- A parent is in the same list and one level up.
CREATE OR REPLACE FUNCTION metadata_register.check_list_value_parent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_parent metadata_register.reference_list_values;
BEGIN
    IF NEW.parent_value_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.parent_value_id = NEW.id THEN
        RAISE EXCEPTION 'A list value cannot be its own parent' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_parent FROM metadata_register.reference_list_values WHERE id = NEW.parent_value_id;
    IF v_parent.list_id IS DISTINCT FROM NEW.list_id THEN
        RAISE EXCEPTION 'Parent value % is not in the same list', v_parent.value_code USING ERRCODE = '23514';
    END IF;
    IF v_parent.level IS NOT NULL AND NEW.level IS NOT NULL AND NEW.level <> v_parent.level + 1 THEN
        RAISE EXCEPTION 'Value % is at level %, but its parent % is at level %', NEW.value_code, NEW.level, v_parent.value_code, v_parent.level
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_list_value_parent ON metadata_register.reference_list_values;
CREATE TRIGGER trg_check_list_value_parent
    BEFORE INSERT OR UPDATE OF parent_value_id, level, list_id ON metadata_register.reference_list_values
    FOR EACH ROW EXECUTE FUNCTION metadata_register.check_list_value_parent();

-- 2. Level and controlling field on attributes
ALTER TABLE metadata_register.attribute_register
    ADD COLUMN IF NOT EXISTS reference_list_level SMALLINT,
    ADD COLUMN IF NOT EXISTS controlling_attribute_code VARCHAR(100);

COMMENT ON COLUMN metadata_register.attribute_register.reference_list_level IS
'For fields on a tree list: the level whose values this field takes. Null takes every value.';
COMMENT ON COLUMN metadata_register.attribute_register.controlling_attribute_code IS
'The field on the same record whose value narrows this one: only children of that value are valid here.';

-- 3. The GICS list
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('GICS', 'GICS', 'ISSUER', 'Global Industry Classification Standard: 11 sectors, 25 industry groups, 74 industries and 163 sub-industries (2023 structure). Codes are the GICS codes.')
ON CONFLICT (list_code) DO NOTHING;

CREATE TEMP TABLE gics_values (code TEXT, label TEXT, level SMALLINT, parent_code TEXT, display_order INT, synonyms JSONB);
INSERT INTO gics_values (code, label, level, parent_code, display_order, synonyms) VALUES
    ('10', 'Energy', 1, NULL, 10, '["ENERGY"]'::jsonb),
    ('1010', 'Energy', 2, '10', 20, '[]'::jsonb),
    ('101010', 'Energy Equipment & Services', 3, '1010', 30, '[]'::jsonb),
    ('10101010', 'Oil & Gas Drilling', 4, '101010', 40, '[]'::jsonb),
    ('10101020', 'Oil & Gas Equipment & Services', 4, '101010', 50, '[]'::jsonb),
    ('101020', 'Oil, Gas & Consumable Fuels', 3, '1010', 60, '[]'::jsonb),
    ('10102010', 'Integrated Oil & Gas', 4, '101020', 70, '[]'::jsonb),
    ('10102020', 'Oil & Gas Exploration & Production', 4, '101020', 80, '[]'::jsonb),
    ('10102030', 'Oil & Gas Refining & Marketing', 4, '101020', 90, '[]'::jsonb),
    ('10102040', 'Oil & Gas Storage & Transportation', 4, '101020', 100, '[]'::jsonb),
    ('10102050', 'Coal & Consumable Fuels', 4, '101020', 110, '[]'::jsonb),
    ('15', 'Materials', 1, NULL, 120, '["MATERIALS"]'::jsonb),
    ('1510', 'Materials', 2, '15', 130, '[]'::jsonb),
    ('151010', 'Chemicals', 3, '1510', 140, '[]'::jsonb),
    ('15101010', 'Commodity Chemicals', 4, '151010', 150, '[]'::jsonb),
    ('15101020', 'Diversified Chemicals', 4, '151010', 160, '[]'::jsonb),
    ('15101030', 'Fertilizers & Agricultural Chemicals', 4, '151010', 170, '[]'::jsonb),
    ('15101040', 'Industrial Gases', 4, '151010', 180, '[]'::jsonb),
    ('15101050', 'Specialty Chemicals', 4, '151010', 190, '[]'::jsonb),
    ('151020', 'Construction Materials', 3, '1510', 200, '[]'::jsonb),
    ('15102010', 'Construction Materials', 4, '151020', 210, '[]'::jsonb),
    ('151030', 'Containers & Packaging', 3, '1510', 220, '[]'::jsonb),
    ('15103010', 'Metal, Glass & Plastic Containers', 4, '151030', 230, '[]'::jsonb),
    ('15103020', 'Paper & Plastic Packaging Products & Materials', 4, '151030', 240, '[]'::jsonb),
    ('151040', 'Metals & Mining', 3, '1510', 250, '[]'::jsonb),
    ('15104010', 'Aluminum', 4, '151040', 260, '[]'::jsonb),
    ('15104020', 'Diversified Metals & Mining', 4, '151040', 270, '[]'::jsonb),
    ('15104025', 'Copper', 4, '151040', 280, '[]'::jsonb),
    ('15104030', 'Gold', 4, '151040', 290, '[]'::jsonb),
    ('15104040', 'Precious Metals & Minerals', 4, '151040', 300, '[]'::jsonb),
    ('15104045', 'Silver', 4, '151040', 310, '[]'::jsonb),
    ('15104050', 'Steel', 4, '151040', 320, '[]'::jsonb),
    ('151050', 'Paper & Forest Products', 3, '1510', 330, '[]'::jsonb),
    ('15105010', 'Forest Products', 4, '151050', 340, '[]'::jsonb),
    ('15105020', 'Paper Products', 4, '151050', 350, '[]'::jsonb),
    ('20', 'Industrials', 1, NULL, 360, '["INDUSTRIALS"]'::jsonb),
    ('2010', 'Capital Goods', 2, '20', 370, '[]'::jsonb),
    ('201010', 'Aerospace & Defense', 3, '2010', 380, '[]'::jsonb),
    ('20101010', 'Aerospace & Defense', 4, '201010', 390, '[]'::jsonb),
    ('201020', 'Building Products', 3, '2010', 400, '[]'::jsonb),
    ('20102010', 'Building Products', 4, '201020', 410, '[]'::jsonb),
    ('201030', 'Construction & Engineering', 3, '2010', 420, '[]'::jsonb),
    ('20103010', 'Construction & Engineering', 4, '201030', 430, '[]'::jsonb),
    ('201040', 'Electrical Equipment', 3, '2010', 440, '[]'::jsonb),
    ('20104010', 'Electrical Components & Equipment', 4, '201040', 450, '[]'::jsonb),
    ('20104020', 'Heavy Electrical Equipment', 4, '201040', 460, '[]'::jsonb),
    ('201050', 'Industrial Conglomerates', 3, '2010', 470, '[]'::jsonb),
    ('20105010', 'Industrial Conglomerates', 4, '201050', 480, '[]'::jsonb),
    ('201060', 'Machinery', 3, '2010', 490, '[]'::jsonb),
    ('20106010', 'Construction Machinery & Heavy Transportation Equipment', 4, '201060', 500, '[]'::jsonb),
    ('20106015', 'Agricultural & Farm Machinery', 4, '201060', 510, '[]'::jsonb),
    ('20106020', 'Industrial Machinery & Supplies & Components', 4, '201060', 520, '[]'::jsonb),
    ('201070', 'Trading Companies & Distributors', 3, '2010', 530, '[]'::jsonb),
    ('20107010', 'Trading Companies & Distributors', 4, '201070', 540, '[]'::jsonb),
    ('2020', 'Commercial & Professional Services', 2, '20', 550, '[]'::jsonb),
    ('202010', 'Commercial Services & Supplies', 3, '2020', 560, '[]'::jsonb),
    ('20201010', 'Commercial Printing', 4, '202010', 570, '[]'::jsonb),
    ('20201050', 'Environmental & Facilities Services', 4, '202010', 580, '[]'::jsonb),
    ('20201060', 'Office Services & Supplies', 4, '202010', 590, '[]'::jsonb),
    ('20201070', 'Diversified Support Services', 4, '202010', 600, '[]'::jsonb),
    ('20201080', 'Security & Alarm Services', 4, '202010', 610, '[]'::jsonb),
    ('202020', 'Professional Services', 3, '2020', 620, '[]'::jsonb),
    ('20202010', 'Human Resource & Employment Services', 4, '202020', 630, '[]'::jsonb),
    ('20202020', 'Research & Consulting Services', 4, '202020', 640, '[]'::jsonb),
    ('20202030', 'Data Processing & Outsourced Services', 4, '202020', 650, '[]'::jsonb),
    ('2030', 'Transportation', 2, '20', 660, '[]'::jsonb),
    ('203010', 'Air Freight & Logistics', 3, '2030', 670, '[]'::jsonb),
    ('20301010', 'Air Freight & Logistics', 4, '203010', 680, '[]'::jsonb),
    ('203020', 'Passenger Airlines', 3, '2030', 690, '[]'::jsonb),
    ('20302010', 'Passenger Airlines', 4, '203020', 700, '[]'::jsonb),
    ('203030', 'Marine Transportation', 3, '2030', 710, '[]'::jsonb),
    ('20303010', 'Marine Transportation', 4, '203030', 720, '[]'::jsonb),
    ('203040', 'Ground Transportation', 3, '2030', 730, '[]'::jsonb),
    ('20304010', 'Rail Transportation', 4, '203040', 740, '[]'::jsonb),
    ('20304030', 'Cargo Ground Transportation', 4, '203040', 750, '[]'::jsonb),
    ('20304040', 'Passenger Ground Transportation', 4, '203040', 760, '[]'::jsonb),
    ('203050', 'Transportation Infrastructure', 3, '2030', 770, '[]'::jsonb),
    ('20305010', 'Airport Services', 4, '203050', 780, '[]'::jsonb),
    ('20305020', 'Highways & Railtracks', 4, '203050', 790, '[]'::jsonb),
    ('20305030', 'Marine Ports & Services', 4, '203050', 800, '[]'::jsonb),
    ('25', 'Consumer Discretionary', 1, NULL, 810, '["CONSUMER_DISCRETIONARY"]'::jsonb),
    ('2510', 'Automobiles & Components', 2, '25', 820, '[]'::jsonb),
    ('251010', 'Automobile Components', 3, '2510', 830, '[]'::jsonb),
    ('25101010', 'Automotive Parts & Equipment', 4, '251010', 840, '[]'::jsonb),
    ('25101020', 'Tires & Rubber', 4, '251010', 850, '[]'::jsonb),
    ('251020', 'Automobiles', 3, '2510', 860, '[]'::jsonb),
    ('25102010', 'Automobile Manufacturers', 4, '251020', 870, '[]'::jsonb),
    ('25102020', 'Motorcycle Manufacturers', 4, '251020', 880, '[]'::jsonb),
    ('2520', 'Consumer Durables & Apparel', 2, '25', 890, '[]'::jsonb),
    ('252010', 'Household Durables', 3, '2520', 900, '[]'::jsonb),
    ('25201010', 'Consumer Electronics', 4, '252010', 910, '[]'::jsonb),
    ('25201020', 'Home Furnishings', 4, '252010', 920, '[]'::jsonb),
    ('25201030', 'Homebuilding', 4, '252010', 930, '[]'::jsonb),
    ('25201040', 'Household Appliances', 4, '252010', 940, '[]'::jsonb),
    ('25201050', 'Housewares & Specialties', 4, '252010', 950, '[]'::jsonb),
    ('252020', 'Leisure Products', 3, '2520', 960, '[]'::jsonb),
    ('25202010', 'Leisure Products', 4, '252020', 970, '[]'::jsonb),
    ('252030', 'Textiles, Apparel & Luxury Goods', 3, '2520', 980, '[]'::jsonb),
    ('25203010', 'Apparel, Accessories & Luxury Goods', 4, '252030', 990, '[]'::jsonb),
    ('25203020', 'Footwear', 4, '252030', 1000, '[]'::jsonb),
    ('25203030', 'Textiles', 4, '252030', 1010, '[]'::jsonb),
    ('2530', 'Consumer Services', 2, '25', 1020, '[]'::jsonb),
    ('253010', 'Hotels, Restaurants & Leisure', 3, '2530', 1030, '[]'::jsonb),
    ('25301010', 'Casinos & Gaming', 4, '253010', 1040, '[]'::jsonb),
    ('25301020', 'Hotels, Resorts & Cruise Lines', 4, '253010', 1050, '[]'::jsonb),
    ('25301030', 'Leisure Facilities', 4, '253010', 1060, '[]'::jsonb),
    ('25301040', 'Restaurants', 4, '253010', 1070, '[]'::jsonb),
    ('253020', 'Diversified Consumer Services', 3, '2530', 1080, '[]'::jsonb),
    ('25302010', 'Education Services', 4, '253020', 1090, '[]'::jsonb),
    ('25302020', 'Specialized Consumer Services', 4, '253020', 1100, '[]'::jsonb),
    ('2550', 'Consumer Discretionary Distribution & Retail', 2, '25', 1110, '[]'::jsonb),
    ('255010', 'Distributors', 3, '2550', 1120, '[]'::jsonb),
    ('25501010', 'Distributors', 4, '255010', 1130, '[]'::jsonb),
    ('255030', 'Broadline Retail', 3, '2550', 1140, '[]'::jsonb),
    ('25503030', 'Broadline Retail', 4, '255030', 1150, '[]'::jsonb),
    ('255040', 'Specialty Retail', 3, '2550', 1160, '[]'::jsonb),
    ('25504010', 'Apparel Retail', 4, '255040', 1170, '[]'::jsonb),
    ('25504020', 'Computer & Electronics Retail', 4, '255040', 1180, '[]'::jsonb),
    ('25504030', 'Home Improvement Retail', 4, '255040', 1190, '[]'::jsonb),
    ('25504040', 'Other Specialty Retail', 4, '255040', 1200, '[]'::jsonb),
    ('25504050', 'Automotive Retail', 4, '255040', 1210, '[]'::jsonb),
    ('25504060', 'Homefurnishing Retail', 4, '255040', 1220, '[]'::jsonb),
    ('30', 'Consumer Staples', 1, NULL, 1230, '["CONSUMER_STAPLES"]'::jsonb),
    ('3010', 'Consumer Staples Distribution & Retail', 2, '30', 1240, '[]'::jsonb),
    ('301010', 'Consumer Staples Distribution & Retail', 3, '3010', 1250, '[]'::jsonb),
    ('30101010', 'Drug Retail', 4, '301010', 1260, '[]'::jsonb),
    ('30101020', 'Food Distributors', 4, '301010', 1270, '[]'::jsonb),
    ('30101030', 'Food Retail', 4, '301010', 1280, '[]'::jsonb),
    ('30101040', 'Consumer Staples Merchandise Retail', 4, '301010', 1290, '[]'::jsonb),
    ('3020', 'Food, Beverage & Tobacco', 2, '30', 1300, '[]'::jsonb),
    ('302010', 'Beverages', 3, '3020', 1310, '[]'::jsonb),
    ('30201010', 'Brewers', 4, '302010', 1320, '[]'::jsonb),
    ('30201020', 'Distillers & Vintners', 4, '302010', 1330, '[]'::jsonb),
    ('30201030', 'Soft Drinks & Non-alcoholic Beverages', 4, '302010', 1340, '[]'::jsonb),
    ('302020', 'Food Products', 3, '3020', 1350, '[]'::jsonb),
    ('30202010', 'Agricultural Products & Services', 4, '302020', 1360, '[]'::jsonb),
    ('30202030', 'Packaged Foods & Meats', 4, '302020', 1370, '[]'::jsonb),
    ('302030', 'Tobacco', 3, '3020', 1380, '[]'::jsonb),
    ('30203010', 'Tobacco', 4, '302030', 1390, '[]'::jsonb),
    ('3030', 'Household & Personal Products', 2, '30', 1400, '[]'::jsonb),
    ('303010', 'Household Products', 3, '3030', 1410, '[]'::jsonb),
    ('30301010', 'Household Products', 4, '303010', 1420, '[]'::jsonb),
    ('303020', 'Personal Care Products', 3, '3030', 1430, '[]'::jsonb),
    ('30302010', 'Personal Care Products', 4, '303020', 1440, '[]'::jsonb),
    ('35', 'Health Care', 1, NULL, 1450, '["HEALTH_CARE", "Healthcare"]'::jsonb),
    ('3510', 'Health Care Equipment & Services', 2, '35', 1460, '[]'::jsonb),
    ('351010', 'Health Care Equipment & Supplies', 3, '3510', 1470, '[]'::jsonb),
    ('35101010', 'Health Care Equipment', 4, '351010', 1480, '[]'::jsonb),
    ('35101020', 'Health Care Supplies', 4, '351010', 1490, '[]'::jsonb),
    ('351020', 'Health Care Providers & Services', 3, '3510', 1500, '[]'::jsonb),
    ('35102010', 'Health Care Distributors', 4, '351020', 1510, '[]'::jsonb),
    ('35102015', 'Health Care Services', 4, '351020', 1520, '[]'::jsonb),
    ('35102020', 'Health Care Facilities', 4, '351020', 1530, '[]'::jsonb),
    ('35102030', 'Managed Health Care', 4, '351020', 1540, '[]'::jsonb),
    ('351030', 'Health Care Technology', 3, '3510', 1550, '[]'::jsonb),
    ('35103010', 'Health Care Technology', 4, '351030', 1560, '[]'::jsonb),
    ('3520', 'Pharmaceuticals, Biotechnology & Life Sciences', 2, '35', 1570, '[]'::jsonb),
    ('352010', 'Biotechnology', 3, '3520', 1580, '[]'::jsonb),
    ('35201010', 'Biotechnology', 4, '352010', 1590, '[]'::jsonb),
    ('352020', 'Pharmaceuticals', 3, '3520', 1600, '[]'::jsonb),
    ('35202010', 'Pharmaceuticals', 4, '352020', 1610, '[]'::jsonb),
    ('352030', 'Life Sciences Tools & Services', 3, '3520', 1620, '[]'::jsonb),
    ('35203010', 'Life Sciences Tools & Services', 4, '352030', 1630, '[]'::jsonb),
    ('40', 'Financials', 1, NULL, 1640, '["FINANCIALS"]'::jsonb),
    ('4010', 'Banks', 2, '40', 1650, '[]'::jsonb),
    ('401010', 'Banks', 3, '4010', 1660, '[]'::jsonb),
    ('40101010', 'Diversified Banks', 4, '401010', 1670, '[]'::jsonb),
    ('40101015', 'Regional Banks', 4, '401010', 1680, '[]'::jsonb),
    ('4020', 'Financial Services', 2, '40', 1690, '[]'::jsonb),
    ('402010', 'Financial Services', 3, '4020', 1700, '[]'::jsonb),
    ('40201020', 'Diversified Financial Services', 4, '402010', 1710, '[]'::jsonb),
    ('40201030', 'Multi-Sector Holdings', 4, '402010', 1720, '[]'::jsonb),
    ('40201040', 'Specialized Finance', 4, '402010', 1730, '[]'::jsonb),
    ('40201050', 'Commercial & Residential Mortgage Finance', 4, '402010', 1740, '[]'::jsonb),
    ('40201060', 'Transaction & Payment Processing Services', 4, '402010', 1750, '[]'::jsonb),
    ('402020', 'Consumer Finance', 3, '4020', 1760, '[]'::jsonb),
    ('40202010', 'Consumer Finance', 4, '402020', 1770, '[]'::jsonb),
    ('402030', 'Capital Markets', 3, '4020', 1780, '[]'::jsonb),
    ('40203010', 'Asset Management & Custody Banks', 4, '402030', 1790, '[]'::jsonb),
    ('40203020', 'Investment Banking & Brokerage', 4, '402030', 1800, '[]'::jsonb),
    ('40203030', 'Diversified Capital Markets', 4, '402030', 1810, '[]'::jsonb),
    ('40203040', 'Financial Exchanges & Data', 4, '402030', 1820, '[]'::jsonb),
    ('402040', 'Mortgage Real Estate Investment Trusts (REITs)', 3, '4020', 1830, '[]'::jsonb),
    ('40204010', 'Mortgage REITs', 4, '402040', 1840, '[]'::jsonb),
    ('4030', 'Insurance', 2, '40', 1850, '[]'::jsonb),
    ('403010', 'Insurance', 3, '4030', 1860, '[]'::jsonb),
    ('40301010', 'Insurance Brokers', 4, '403010', 1870, '[]'::jsonb),
    ('40301020', 'Life & Health Insurance', 4, '403010', 1880, '[]'::jsonb),
    ('40301030', 'Multi-line Insurance', 4, '403010', 1890, '[]'::jsonb),
    ('40301040', 'Property & Casualty Insurance', 4, '403010', 1900, '[]'::jsonb),
    ('40301050', 'Reinsurance', 4, '403010', 1910, '[]'::jsonb),
    ('45', 'Information Technology', 1, NULL, 1920, '["INFORMATION_TECHNOLOGY", "IT", "Technology"]'::jsonb),
    ('4510', 'Software & Services', 2, '45', 1930, '[]'::jsonb),
    ('451020', 'IT Services', 3, '4510', 1940, '[]'::jsonb),
    ('45102010', 'IT Consulting & Other Services', 4, '451020', 1950, '[]'::jsonb),
    ('45102030', 'Internet Services & Infrastructure', 4, '451020', 1960, '[]'::jsonb),
    ('451030', 'Software', 3, '4510', 1970, '[]'::jsonb),
    ('45103010', 'Application Software', 4, '451030', 1980, '[]'::jsonb),
    ('45103020', 'Systems Software', 4, '451030', 1990, '[]'::jsonb),
    ('4520', 'Technology Hardware & Equipment', 2, '45', 2000, '[]'::jsonb),
    ('452010', 'Communications Equipment', 3, '4520', 2010, '[]'::jsonb),
    ('45201020', 'Communications Equipment', 4, '452010', 2020, '[]'::jsonb),
    ('452020', 'Technology Hardware, Storage & Peripherals', 3, '4520', 2030, '[]'::jsonb),
    ('45202030', 'Technology Hardware, Storage & Peripherals', 4, '452020', 2040, '[]'::jsonb),
    ('452030', 'Electronic Equipment, Instruments & Components', 3, '4520', 2050, '[]'::jsonb),
    ('45203010', 'Electronic Equipment & Instruments', 4, '452030', 2060, '[]'::jsonb),
    ('45203015', 'Electronic Components', 4, '452030', 2070, '[]'::jsonb),
    ('45203020', 'Electronic Manufacturing Services', 4, '452030', 2080, '[]'::jsonb),
    ('45203030', 'Technology Distributors', 4, '452030', 2090, '[]'::jsonb),
    ('4530', 'Semiconductors & Semiconductor Equipment', 2, '45', 2100, '[]'::jsonb),
    ('453010', 'Semiconductors & Semiconductor Equipment', 3, '4530', 2110, '[]'::jsonb),
    ('45301010', 'Semiconductor Materials & Equipment', 4, '453010', 2120, '[]'::jsonb),
    ('45301020', 'Semiconductors', 4, '453010', 2130, '[]'::jsonb),
    ('50', 'Communication Services', 1, NULL, 2140, '["COMMUNICATION_SERVICES", "Telecom"]'::jsonb),
    ('5010', 'Telecommunication Services', 2, '50', 2150, '[]'::jsonb),
    ('501010', 'Diversified Telecommunication Services', 3, '5010', 2160, '[]'::jsonb),
    ('50101010', 'Alternative Carriers', 4, '501010', 2170, '[]'::jsonb),
    ('50101020', 'Integrated Telecommunication Services', 4, '501010', 2180, '[]'::jsonb),
    ('501020', 'Wireless Telecommunication Services', 3, '5010', 2190, '[]'::jsonb),
    ('50102010', 'Wireless Telecommunication Services', 4, '501020', 2200, '[]'::jsonb),
    ('5020', 'Media & Entertainment', 2, '50', 2210, '[]'::jsonb),
    ('502010', 'Media', 3, '5020', 2220, '[]'::jsonb),
    ('50201010', 'Advertising', 4, '502010', 2230, '[]'::jsonb),
    ('50201020', 'Broadcasting', 4, '502010', 2240, '[]'::jsonb),
    ('50201030', 'Cable & Satellite', 4, '502010', 2250, '[]'::jsonb),
    ('50201040', 'Publishing', 4, '502010', 2260, '[]'::jsonb),
    ('502020', 'Entertainment', 3, '5020', 2270, '[]'::jsonb),
    ('50202010', 'Movies & Entertainment', 4, '502020', 2280, '[]'::jsonb),
    ('50202020', 'Interactive Home Entertainment', 4, '502020', 2290, '[]'::jsonb),
    ('502030', 'Interactive Media & Services', 3, '5020', 2300, '[]'::jsonb),
    ('50203010', 'Interactive Media & Services', 4, '502030', 2310, '[]'::jsonb),
    ('55', 'Utilities', 1, NULL, 2320, '["UTILITIES"]'::jsonb),
    ('5510', 'Utilities', 2, '55', 2330, '[]'::jsonb),
    ('551010', 'Electric Utilities', 3, '5510', 2340, '[]'::jsonb),
    ('55101010', 'Electric Utilities', 4, '551010', 2350, '[]'::jsonb),
    ('551020', 'Gas Utilities', 3, '5510', 2360, '[]'::jsonb),
    ('55102010', 'Gas Utilities', 4, '551020', 2370, '[]'::jsonb),
    ('551030', 'Multi-Utilities', 3, '5510', 2380, '[]'::jsonb),
    ('55103010', 'Multi-Utilities', 4, '551030', 2390, '[]'::jsonb),
    ('551040', 'Water Utilities', 3, '5510', 2400, '[]'::jsonb),
    ('55104010', 'Water Utilities', 4, '551040', 2410, '[]'::jsonb),
    ('551050', 'Independent Power and Renewable Electricity Producers', 3, '5510', 2420, '[]'::jsonb),
    ('55105010', 'Independent Power Producers & Energy Traders', 4, '551050', 2430, '[]'::jsonb),
    ('55105020', 'Renewable Electricity', 4, '551050', 2440, '[]'::jsonb),
    ('60', 'Real Estate', 1, NULL, 2450, '["REAL_ESTATE"]'::jsonb),
    ('6010', 'Equity Real Estate Investment Trusts (REITs)', 2, '60', 2460, '[]'::jsonb),
    ('601010', 'Diversified REITs', 3, '6010', 2470, '[]'::jsonb),
    ('60101010', 'Diversified REITs', 4, '601010', 2480, '[]'::jsonb),
    ('601025', 'Industrial REITs', 3, '6010', 2490, '[]'::jsonb),
    ('60102510', 'Industrial REITs', 4, '601025', 2500, '[]'::jsonb),
    ('601030', 'Hotel & Resort REITs', 3, '6010', 2510, '[]'::jsonb),
    ('60103010', 'Hotel & Resort REITs', 4, '601030', 2520, '[]'::jsonb),
    ('601040', 'Office REITs', 3, '6010', 2530, '[]'::jsonb),
    ('60104010', 'Office REITs', 4, '601040', 2540, '[]'::jsonb),
    ('601050', 'Health Care REITs', 3, '6010', 2550, '[]'::jsonb),
    ('60105010', 'Health Care REITs', 4, '601050', 2560, '[]'::jsonb),
    ('601060', 'Residential REITs', 3, '6010', 2570, '[]'::jsonb),
    ('60106010', 'Multi-Family Residential REITs', 4, '601060', 2580, '[]'::jsonb),
    ('60106020', 'Single-Family Residential REITs', 4, '601060', 2590, '[]'::jsonb),
    ('601070', 'Retail REITs', 3, '6010', 2600, '[]'::jsonb),
    ('60107010', 'Retail REITs', 4, '601070', 2610, '[]'::jsonb),
    ('601080', 'Specialized REITs', 3, '6010', 2620, '[]'::jsonb),
    ('60108010', 'Other Specialized REITs', 4, '601080', 2630, '[]'::jsonb),
    ('60108020', 'Self-Storage REITs', 4, '601080', 2640, '[]'::jsonb),
    ('60108030', 'Telecom Tower REITs', 4, '601080', 2650, '[]'::jsonb),
    ('60108040', 'Timber REITs', 4, '601080', 2660, '[]'::jsonb),
    ('60108050', 'Data Center REITs', 4, '601080', 2670, '[]'::jsonb),
    ('6020', 'Real Estate Management & Development', 2, '60', 2680, '[]'::jsonb),
    ('602010', 'Real Estate Management & Development', 3, '6020', 2690, '[]'::jsonb),
    ('60201010', 'Diversified Real Estate Activities', 4, '602010', 2700, '[]'::jsonb),
    ('60201020', 'Real Estate Operating Companies', 4, '602010', 2710, '[]'::jsonb),
    ('60201030', 'Real Estate Development', 4, '602010', 2720, '[]'::jsonb),
    ('60201040', 'Real Estate Services', 4, '602010', 2730, '[]'::jsonb)
;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms, level)
SELECT l.id, g.code, g.label, g.display_order, g.synonyms, g.level
FROM gics_values g
CROSS JOIN metadata_register.reference_lists l
WHERE l.list_code = 'GICS'
ON CONFLICT (list_id, value_code) DO UPDATE
SET value_label = EXCLUDED.value_label, display_order = EXCLUDED.display_order, level = EXCLUDED.level;

UPDATE metadata_register.reference_list_values child
SET parent_value_id = parent.id
FROM gics_values g, metadata_register.reference_lists l, metadata_register.reference_list_values parent
WHERE l.list_code = 'GICS'
  AND child.list_id = l.id AND child.value_code = g.code
  AND parent.list_id = l.id AND parent.value_code = g.parent_code
  AND child.parent_value_id IS DISTINCT FROM parent.id;

DROP TABLE gics_values;

-- 4. The four GICS fields on Issuer
INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_required, default_precedence_rank, display_section, display_group, is_editable, is_visible,
    reference_list_code, reference_list_level, controlling_attribute_code
)
SELECT v.* FROM (VALUES
    ('GICS_SECTOR_CODE', 'GICS Sector', 'STRING', 'GICS sector (level 1).', 'ISSUER', FALSE, 100, 'Classification', 15, TRUE, TRUE, 'GICS', 1::smallint, NULL::varchar),
    ('GICS_INDUSTRY_GROUP_CODE', 'GICS Industry Group', 'STRING', 'GICS industry group (level 2), under the GICS sector.', 'ISSUER', FALSE, 100, 'Classification', 16, TRUE, TRUE, 'GICS', 2::smallint, 'GICS_SECTOR_CODE'),
    ('GICS_INDUSTRY_CODE', 'GICS Industry', 'STRING', 'GICS industry (level 3), under the GICS industry group.', 'ISSUER', FALSE, 100, 'Classification', 17, TRUE, TRUE, 'GICS', 3::smallint, 'GICS_INDUSTRY_GROUP_CODE')
) AS v(attribute_code, attribute_name, data_type, description, domain_code, is_required, default_precedence_rank, display_section, display_group, is_editable, is_visible, reference_list_code, reference_list_level, controlling_attribute_code)
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.attribute_register a
    WHERE a.attribute_code = v.attribute_code AND a.client_id IS NULL
);

UPDATE metadata_register.attribute_register
SET attribute_name = 'GICS Sub-Industry',
    description = 'GICS sub-industry (level 4), under the GICS industry.',
    reference_list_code = 'GICS',
    reference_list_level = 4,
    controlling_attribute_code = 'GICS_INDUSTRY_CODE',
    display_section = 'Classification',
    display_group = 18
WHERE attribute_code = 'GICS_SUB_INDUSTRY_CODE' AND client_id IS NULL;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT t.id, a.id, FALSE, 100, a.display_group
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.domain_code = 'ISSUER'
WHERE a.attribute_code IN ('GICS_SECTOR_CODE', 'GICS_INDUSTRY_GROUP_CODE', 'GICS_INDUSTRY_CODE', 'GICS_SUB_INDUSTRY_CODE')
  AND a.client_id IS NULL
ON CONFLICT (template_id, attribute_id) DO UPDATE SET display_order = EXCLUDED.display_order;

-- 5. Expose the new columns
CREATE OR REPLACE VIEW public.reference_list_values WITH (security_invoker = on) AS
SELECT id, list_id, value_code, value_label, display_order, is_active, metadata, created_at, synonyms,
       parent_value_id, level
FROM metadata_register.reference_list_values;

CREATE OR REPLACE VIEW public.attribute_register WITH (security_invoker = on) AS
SELECT
  id, attribute_code, attribute_name, data_type, description, unit_of_measure,
  validation_regex, is_required, is_multi_valued, reference_domain_code,
  default_precedence_rank, metadata, created_at, updated_at, is_derived,
  display_format, list_values, validation_rules, default_value, display_section,
  display_group, is_editable, is_visible, derivation_formula, derivation_dependencies,
  derivation_type, formula_language, aggregation_type, weight_attribute_code,
  numeric_precision, domain_code, reference_list_code, is_time_varying, time_dimension,
  client_id, reporting_grain, period_alignment, period_rollup,
  display_span_columns, display_span_rows,
  reference_list_level, controlling_attribute_code
FROM metadata_register.attribute_register;

CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code character varying DEFAULT NULL::character varying)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'metadata_register', 'pg_temp'
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  SELECT COALESCE(
    (
      SELECT jsonb_agg(attr_obj)
      FROM (
        SELECT jsonb_build_object(
          'id', id,
          'attribute_code', attribute_code,
          'attribute_name', attribute_name,
          'data_type', data_type,
          'description', description,
          'unit_of_measure', unit_of_measure,
          'is_required', is_required,
          'is_multi_valued', is_multi_valued,
          'reference_domain_code', reference_domain_code,
          'reference_list_code', reference_list_code,
          'reference_list_level', reference_list_level,
          'controlling_attribute_code', controlling_attribute_code,
          'domain_code', domain_code,
          'client_id', client_id,
          'default_precedence_rank', default_precedence_rank,
          'is_derived', is_derived,
          'derivation_type', derivation_type,
          'derivation_formula', derivation_formula,
          'derivation_dependencies', derivation_dependencies,
          'display_format', display_format,
          'list_values', list_values,
          'validation_rules', validation_rules,
          'default_value', default_value,
          'display_section', display_section,
          'display_group', display_group,
          'display_span_columns', display_span_columns,
          'display_span_rows', display_span_rows,
          'is_editable', is_editable,
          'is_visible', is_visible,
          'aggregation_type', COALESCE(aggregation_type, 'NONE'),
          'weight_attribute_code', weight_attribute_code,
          'numeric_precision', numeric_precision
        ) AS attr_obj
        FROM metadata_register.attribute_register
        WHERE (p_domain_code IS NULL OR domain_code = p_domain_code)
        ORDER BY attribute_code
      ) sub
    ),
    '[]'::jsonb
  )
  INTO v_result;
  RETURN v_result;
END;
$function$;


-- 6. Quality rules: a value sits under its controlling field's value.
-- Rule expressions gain one clause, CHILD IS UNDER PARENT, true when the child's
-- value is a child of the parent's value on the child field's list.
CREATE OR REPLACE FUNCTION metadata_register.list_value_is_under(p_attribute_code text, p_child text, p_parent text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM metadata_register.attribute_register a
        JOIN metadata_register.reference_lists l ON l.list_code = a.reference_list_code
        JOIN metadata_register.reference_list_values child
          ON child.list_id = l.id AND lower(child.value_code) = lower(btrim(p_child))
        JOIN metadata_register.reference_list_values parent
          ON parent.id = child.parent_value_id AND lower(parent.value_code) = lower(btrim(p_parent))
        WHERE upper(a.attribute_code) = upper(p_attribute_code)
    );
$$;

REVOKE ALL ON FUNCTION metadata_register.list_value_is_under(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata_register.list_value_is_under(text, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION metadata_register.list_value_is_under(text, text, text) IS
'True when p_child is a child of p_parent on the list p_attribute_code takes its values from.';

CREATE OR REPLACE FUNCTION data_quality.compile_rule_clause(p_clause text)
 RETURNS TABLE(pred text, msg text, actual text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$

DECLARE

  v_clause text := btrim(p_clause);

  v_m text[];

  v_attr text;

  v_op text;

  v_rhs text;

  v_val text;

  v_items text[] := ARRAY[]::text[];

  v_item text;
  v_other text;

  v_num_like text := '^-?[0-9]+([.][0-9]+)?$';

  v_date_like text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$';

BEGIN

  IF v_clause = '' THEN

    RAISE EXCEPTION 'Rule expression has an empty clause';

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NOT[[:space:]]+NULL$', 'i');

  IF v_m IS NULL THEN

    v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+NULL$', 'i');

    IF v_m IS NOT NULL THEN

      v_attr := v_m[1];

      v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

      pred := format('(%s IS NULL)', v_val);

      msg := format('%L', v_attr || ' is present');

      actual := v_val;

      RETURN NEXT;

      RETURN;

    END IF;

  ELSE

    v_attr := v_m[1];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format('(%s IS NOT NULL)', v_val);

    msg := format('%L', v_attr || ' is missing');

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*(-?[0-9]+(?:[.][0-9]+)?)$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_op := v_m[2];

    v_rhs := v_m[3];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format(

      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::numeric %3$s %4$s) END)',

      v_val, v_num_like, v_op, v_rhs

    );

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L END)',

      v_val, v_attr || ' is missing', v_num_like, v_attr || ' is not a number', v_attr || ' failed ' || v_op || ' ' || v_rhs

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*CURRENT_DATE$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_op := v_m[2];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format(

      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s as_of) END)',

      v_val, v_date_like, v_op

    );

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L || '' ('' || as_of::text || '')'' END)',

      v_val, v_attr || ' is missing', v_date_like, v_attr || ' is not a date', v_attr || ' failed ' || v_op || ' CURRENT_DATE'

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*''([0-9]{4}-[0-9]{2}-[0-9]{2})''$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_op := v_m[2];

    v_rhs := v_m[3];

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format(

      '(CASE WHEN %1$s IS NULL THEN false WHEN %1$s !~ %2$L THEN false ELSE (%1$s::date %3$s DATE %4$L) END)',

      v_val, v_date_like, v_op, v_rhs

    );

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L WHEN %1$s !~ %3$L THEN %4$L ELSE %5$L END)',

      v_val, v_attr || ' is missing', v_date_like, v_attr || ' is not a date', v_attr || ' failed ' || v_op || ' ' || v_rhs

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*~[[:space:]]*''((?:[^'']|'')*)''$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    v_rhs := replace(v_m[2], '''''', '''');

    BEGIN

      PERFORM '' ~ v_rhs;

    EXCEPTION WHEN invalid_regular_expression THEN

      RAISE EXCEPTION 'Invalid regular expression on %', v_attr;

    END;

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format('(%1$s IS NOT NULL AND %1$s ~ %2$L)', v_val, v_rhs);

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L ELSE %3$L END)',

      v_val, v_attr || ' is missing', v_attr || ' does not match the expected format'

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IN[[:space:]]*\((.*)\)[[:space:]]*$', 'i');

  IF v_m IS NOT NULL THEN

    v_attr := v_m[1];

    FOR v_item IN

      SELECT match[1] FROM regexp_matches(v_m[2], '''([^'']*)''', 'g') AS match

    LOOP

      v_items := v_items || format('%L', lower(replace(v_item, '''''', '''')));

    END LOOP;

    IF cardinality(v_items) = 0 THEN

      RAISE EXCEPTION 'IN list on % has no quoted values', v_attr;

    END IF;

    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));

    pred := format('(%1$s IS NOT NULL AND lower(%1$s) IN (%2$s))', v_val, array_to_string(v_items, ', '));

    msg := format(

      '(CASE WHEN %1$s IS NULL THEN %2$L ELSE %3$L END)',

      v_val, v_attr || ' is missing', v_attr || ' is not an allowed value'

    );

    actual := v_val;

    RETURN NEXT;

    RETURN;

  END IF;



  -- One attribute compared with another: MATURITY_DATE > ISSUANCE_DATE.
  -- Dates compare as dates, numbers as numbers, anything else as text.
  -- A blank on either side fails, the same as the interpreted evaluator.
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*(>=|<=|<>|!=|=|>|<)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)$', 'i');
  IF v_m IS NOT NULL AND upper(v_m[3]) NOT IN ('NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'YESTERDAY') THEN
    v_attr := v_m[1];
    v_op := CASE WHEN v_m[2] = '!=' THEN '<>' ELSE v_m[2] END;
    v_rhs := v_m[3];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    v_other := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_rhs));
    pred := format(
      '(CASE WHEN %1$s IS NULL OR %2$s IS NULL THEN false WHEN %1$s ~ %3$L AND %2$s ~ %3$L THEN (%1$s::date %5$s %2$s::date) WHEN %1$s ~ %4$L AND %2$s ~ %4$L THEN (%1$s::numeric %5$s %2$s::numeric) ELSE (%1$s %5$s %2$s) END)',
      v_val, v_other, v_date_like, v_num_like, v_op
    );
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %3$L WHEN %2$s IS NULL THEN %4$L ELSE %5$L END)',
      v_val, v_other, v_attr || ' is missing', v_rhs || ' is missing', v_attr || ' failed ' || v_op || ' ' || v_rhs
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  -- CHILD IS UNDER PARENT: the child's value sits under the parent's value on the child field's list.
  v_m := regexp_match(v_clause, '^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+IS[[:space:]]+UNDER[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)$', 'i');
  IF v_m IS NOT NULL THEN
    v_attr := v_m[1];
    v_rhs := v_m[2];
    v_val := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_attr));
    v_other := format('NULLIF(btrim(vals ->> %L), '''')', lower(v_rhs));
    pred := format(
      '(%1$s IS NOT NULL AND %2$s IS NOT NULL AND metadata_register.list_value_is_under(%3$L, %1$s, %2$s))',
      v_val, v_other, upper(v_attr)
    );
    msg := format(
      '(CASE WHEN %1$s IS NULL THEN %3$L WHEN %2$s IS NULL THEN %4$L ELSE %5$L END)',
      v_val, v_other, v_attr || ' is missing', v_rhs || ' is missing', v_attr || ' is not under ' || v_rhs
    );
    actual := v_val;
    RETURN NEXT;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Expression is not supported: %', v_clause;

END;

$function$;


DO $$
BEGIN
  CREATE TEMP TABLE _tree_rules ON COMMIT DROP AS
  SELECT v.rule_code, v.rule_name, ar.domain_code, ar.id AS attribute_id, 'CONSISTENCY'::varchar AS rule_type,
         'HIGH'::varchar AS rule_severity, v.rule_expression, v.rule_description
  FROM (VALUES
    ('GICS_INDUSTRY_GROUP_UNDER_SECTOR', 'GICS Industry Group Under Sector', 'GICS_INDUSTRY_GROUP_CODE',
     'GICS_INDUSTRY_GROUP_CODE IS NULL OR GICS_SECTOR_CODE IS NULL OR GICS_INDUSTRY_GROUP_CODE IS UNDER GICS_SECTOR_CODE',
     'The GICS industry group belongs to a different sector than the one on the record.'),
    ('GICS_INDUSTRY_UNDER_GROUP', 'GICS Industry Under Industry Group', 'GICS_INDUSTRY_CODE',
     'GICS_INDUSTRY_CODE IS NULL OR GICS_INDUSTRY_GROUP_CODE IS NULL OR GICS_INDUSTRY_CODE IS UNDER GICS_INDUSTRY_GROUP_CODE',
     'The GICS industry belongs to a different industry group than the one on the record.'),
    ('GICS_SUB_INDUSTRY_UNDER_INDUSTRY', 'GICS Sub-Industry Under Industry', 'GICS_SUB_INDUSTRY_CODE',
     'GICS_SUB_INDUSTRY_CODE IS NULL OR GICS_INDUSTRY_CODE IS NULL OR GICS_SUB_INDUSTRY_CODE IS UNDER GICS_INDUSTRY_CODE',
     'The GICS sub-industry belongs to a different industry than the one on the record.')
  ) AS v(rule_code, rule_name, attribute_code, rule_expression, rule_description)
  JOIN metadata_register.attribute_register ar
    ON ar.domain_code = 'ISSUER' AND ar.attribute_code = v.attribute_code AND ar.client_id IS NULL;

  INSERT INTO data_quality.dq_rules
    (rule_code, rule_name, domain_code, attribute_id, rule_type, rule_severity, rule_expression, rule_description, is_active)
  SELECT rule_code, rule_name, domain_code, attribute_id, rule_type, rule_severity, rule_expression, rule_description, true
  FROM _tree_rules
  ON CONFLICT (rule_code) DO UPDATE
  SET rule_name = EXCLUDED.rule_name,
      domain_code = EXCLUDED.domain_code,
      attribute_id = EXCLUDED.attribute_id,
      rule_type = EXCLUDED.rule_type,
      rule_severity = EXCLUDED.rule_severity,
      rule_expression = EXCLUDED.rule_expression,
      rule_description = EXCLUDED.rule_description,
      is_active = true,
      updated_at = NOW();
END $$;

NOTIFY pgrst, 'reload schema';
