-- Migration: Row Level Security Policies
-- Description: RLS policies for multi-tenant security and role-based access

-- Enable RLS on all tables
ALTER TABLE metadata_register.domain_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.attribute_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.domain_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.template_attribute_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.reference_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.reference_list_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE entity_instances.source_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.master_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.feed_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.source_attribute_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE golden_master.entity_attribute_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE position_master.dimensional_intersections ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_master.position_metrics ENABLE ROW LEVEL SECURITY;

ALTER TABLE data_quality.dq_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality.dq_exceptions ENABLE ROW LEVEL SECURITY;

-- Policy: Metadata register is readable by all authenticated users
CREATE POLICY "Metadata register readable by authenticated" ON metadata_register.domain_types
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Attribute register readable by authenticated" ON metadata_register.attribute_register
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Domain templates readable by authenticated" ON metadata_register.domain_templates
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Template assignments readable by authenticated" ON metadata_register.template_attribute_assignments
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Reference lists readable by authenticated" ON metadata_register.reference_lists
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Reference values readable by authenticated" ON metadata_register.reference_list_values
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: Source registry readable by authenticated
CREATE POLICY "Source registry readable by authenticated" ON entity_instances.source_registry
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: Master entities readable by authenticated, writable by admins
CREATE POLICY "Master entities readable by authenticated" ON entity_instances.master_entities
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Master entities writable by admins" ON entity_instances.master_entities
    FOR ALL TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM auth.users
            WHERE id = auth.uid()
            AND raw_user_meta_data->>'role' IN ('admin', 'steward', 'ops')
        )
    );

-- Policy: Feed lineage readable by authenticated
CREATE POLICY "Feed lineage readable by authenticated" ON entity_instances.feed_lineage
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: Source attribute values readable by authenticated
CREATE POLICY "Source attribute values readable by authenticated" ON entity_instances.source_attribute_values
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: Golden master readable by authenticated
CREATE POLICY "Golden master readable by authenticated" ON golden_master.entity_attribute_values
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: Golden master writable by admins and stewards
CREATE POLICY "Golden master writable by authorized" ON golden_master.entity_attribute_values
    FOR ALL TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM auth.users
            WHERE id = auth.uid()
            AND raw_user_meta_data->>'role' IN ('admin', 'steward')
        )
    );

-- Policy: Position master readable by authenticated
CREATE POLICY "Position intersections readable by authenticated" ON position_master.dimensional_intersections
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Position metrics readable by authenticated" ON position_master.position_metrics
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: DQ rules readable by authenticated
CREATE POLICY "DQ rules readable by authenticated" ON data_quality.dq_rules
    FOR SELECT TO authenticated USING (TRUE);

-- Policy: DQ exceptions readable by authenticated, writable by ops and admins
CREATE POLICY "DQ exceptions readable by authenticated" ON data_quality.dq_exceptions
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "DQ exceptions writable by ops" ON data_quality.dq_exceptions
    FOR ALL TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM auth.users
            WHERE id = auth.uid()
            AND raw_user_meta_data->>'role' IN ('admin', 'ops', 'steward')
        )
    );

-- Function to check user role
CREATE OR REPLACE FUNCTION public.check_user_role(required_role TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM auth.users
        WHERE id = auth.uid()
        AND raw_user_meta_data->>'role' = required_role
    );
END;
$$;

-- Function to get current user role
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN (
        SELECT raw_user_meta_data->>'role'
        FROM auth.users
        WHERE id = auth.uid()
    );
END;
$$;
