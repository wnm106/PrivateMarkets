import { ToolRegistry } from '../lib/tool-registry.js';
import { ToolDefinition } from '../lib/types.js';

const getAttributeMetadata: ToolDefinition = {
  name: 'get_attribute_metadata',
  description: 'Get detailed metadata for one or more attributes including descriptions, data types, validation rules, and allowed values. Essential for understanding what data each attribute represents.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      attributeCodes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of attribute codes to retrieve (e.g., ["CUSIP", "ISIN", "NOTIONAL"]). If omitted, returns all attributes.',
      },
      domainCode: {
        type: 'string',
        description: 'Filter attributes by domain code (e.g., "SECURITY", "FUND", "ISSUER")',
      },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase
      .from('attribute_register')
      .select(`
        id,
        attribute_code,
        attribute_name,
        description,
        data_type,
        unit_of_measure,
        is_required,
        is_multi_valued,
        list_values,
        validation_rules,
        default_value,
        display_format,
        reference_domain_code
      `)
      .order('attribute_code');

    if (args.attributeCodes && args.attributeCodes.length > 0) {
      query = query.in('attribute_code', args.attributeCodes);
    }

    if (args.domainCode) {
      query = query.eq('reference_domain_code', args.domainCode);
    }

    const { data, error } = await query;
    if (error) throw error;

    return {
      attributes: data || [],
      count: data?.length || 0,
    };
  },
};

const getTemplateMetadata: ToolDefinition = {
  name: 'get_template_metadata',
  description: 'Get template definitions including which attributes are required for each template. Helps understand the structure and required fields for different entity types.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      templateCodes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of template codes to retrieve (e.g., ["LOAN", "BOND", "EQUITY"]). If omitted, returns all templates.',
      },
      domainCode: {
        type: 'string',
        description: 'Filter templates by domain code (e.g., "SECURITY", "FUND")',
      },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase
      .from('domain_templates')
      .select(`
        id,
        template_code,
        template_name,
        domain_code,
        description,
        is_active,
        template_attribute_assignments (
          attribute_code,
          attribute_name,
          is_required,
          display_order,
          display_label,
          attribute_register (
            description,
            data_type,
            list_values
          )
        )
      `)
      .order('template_code');

    if (args.templateCodes && args.templateCodes.length > 0) {
      query = query.in('template_code', args.templateCodes);
    }

    if (args.domainCode) {
      query = query.eq('domain_code', args.domainCode);
    }

    const { data, error } = await query;
    if (error) throw error;

    return {
      templates: data || [],
      count: data?.length || 0,
    };
  },
};

const getEntity: ToolDefinition = {
  name: 'get_entity',
  description: 'Get any entity by ID or entity code from the generic entity master view. Returns entity with all attributes and relationships as JSONB.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'Entity ID' },
      entityCode: { type: 'string', description: 'Entity code' },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase.from('entity_master').select('*');

    if (args.entityId) query = query.eq('entity_id', args.entityId);
    else if (args.entityCode) query = query.eq('entity_code', args.entityCode);
    else throw new Error('Must provide entityId or entityCode');

    const { data, error } = await query.single();
    if (error) throw error;
    return data;
  },
};

const listEntities: ToolDefinition = {
  name: 'list_entities',
  description: 'List entities of any domain type with optional filtering and pagination. Uses the generic entity_master view.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Domain type to query (e.g., FUND, ISSUER, SECURITY, DEAL, POSITION)' },
      filter: { type: 'object', description: 'Filter criteria (e.g., { "entity_code": "FUND-001" })' },
      first: { type: 'number', description: 'Number of results to return', default: 20 },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase.from('entity_master').select('*', { count: 'exact' });

    if (args.domainCode) {
      query = query.eq('domain_code', args.domainCode);
    }

    if (args.filter) {
      for (const [key, value] of Object.entries(args.filter)) {
        if (typeof value === 'string') {
          query = query.eq(key, value);
        }
      }
    }

    query = query.limit(args.first || 20);
    const { data, error, count } = await query;
    if (error) throw error;

    return { entities: data, totalCount: count };
  },
};

const createEntity: ToolDefinition = {
  name: 'create_entity',
  description: 'Create a new entity of any domain type with attributes and relationships.',
  category: 'domain-write',
  inputSchema: {
    type: 'object',
    properties: {
      entityCode: { type: 'string', description: 'Unique entity code' },
      entityName: { type: 'string', description: 'Entity name' },
      domainCode: { type: 'string', description: 'Domain code (e.g., FUND, ISSUER, SECURITY)' },
      templateCode: { type: 'string', description: 'Optional template code' },
      description: { type: 'string', description: 'Optional description' },
      attributes: { type: 'object', description: 'Attribute values as key-value pairs' },
    },
    required: ['entityCode', 'entityName', 'domainCode'],
  },
  execute: async (args, supabase) => {
    // Get template_id if templateCode provided
    let templateId = null;
    if (args.templateCode) {
      const { data: template } = await supabase
        .from('domain_templates')
        .select('id')
        .eq('template_code', args.templateCode)
        .single();
      templateId = template?.id;
    }

    // Insert into master_entities
    const { data: entity, error: entityError } = await supabase
      .from('master_entities')
      .insert({
        entity_code: args.entityCode,
        entity_name: args.entityName,
        domain_code: args.domainCode,
        template_id: templateId,
        description: args.description,
      })
      .select()
      .single();

    if (entityError) throw entityError;

    // Insert attributes
    if (args.attributes) {
      for (const [attrCode, value] of Object.entries(args.attributes)) {
        const { data: attr } = await supabase
          .from('attribute_register')
          .select('id, default_precedence_rank')
          .eq('attribute_code', attrCode)
          .single();

        if (attr) {
          const { data: source } = await supabase
            .from('source_registry')
            .select('id')
            .eq('source_code', 'MANUAL')
            .single();

          await supabase.from('entity_attribute_values').insert({
            entity_id: entity.id,
            attribute_id: attr.id,
            source_id: source?.id,
            golden_value: typeof value === 'string' ? value : null,
            golden_value_numeric: typeof value === 'number' ? value : null,
            valid_from: new Date().toISOString().split('T')[0],
            precedence_rank: attr.default_precedence_rank,
          });
        }
      }
    }

    return entity;
  },
};

const createRelationship: ToolDefinition = {
  name: 'create_relationship',
  description: 'Create a relationship between two entities (e.g., Security issued by Issuer).',
  category: 'domain-write',
  inputSchema: {
    type: 'object',
    properties: {
      parentEntityId: { type: 'string', description: 'Parent entity ID' },
      childEntityId: { type: 'string', description: 'Child entity ID' },
      relationshipType: { type: 'string', description: 'Relationship type (e.g., ISSUER_OF, HELD_BY)' },
      relationshipCode: { type: 'string', description: 'Relationship code (e.g., SECURITY_ISSUER)' },
      isPrimary: { type: 'boolean', description: 'Is this the primary relationship?', default: false },
      validFrom: { type: 'string', description: 'Valid from date (YYYY-MM-DD)' },
    },
    required: ['parentEntityId', 'childEntityId', 'relationshipType', 'relationshipCode'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('entity_relationships')
      .insert({
        parent_entity_id: args.parentEntityId,
        child_entity_id: args.childEntityId,
        relationship_type: args.relationshipType,
        relationship_code: args.relationshipCode,
        is_primary: args.isPrimary ?? false,
        valid_from: args.validFrom || new Date().toISOString().split('T')[0],
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },
};

const getRelationshipTypes: ToolDefinition = {
  name: 'get_relationship_types',
  description: 'Get all available relationship types and their allowed domain combinations.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('relationship_types')
      .select('*')
      .eq('is_active', true)
      .order('relationship_code');

    if (error) throw error;
    return data;
  },
};

// Intersection Tools

const getIntersectionTypes: ToolDefinition = {
  name: 'get_intersection_types',
  description: 'Get all available intersection types (composite entity definitions) with their member roles.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('intersection_types')
      .select(`
        *,
        intersection_type_members(*)
      `)
      .eq('is_active', true)
      .order('intersection_code');

    if (error) throw error;
    return data;
  },
};

const createIntersectionType: ToolDefinition = {
  name: 'create_intersection_type',
  description: 'Create a new intersection type (composite entity definition). Example: A "Position" intersection that combines Fund + Security.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      intersectionCode: { type: 'string', description: 'Unique code for the intersection type (e.g., POSITION, LOAN)' },
      intersectionName: { type: 'string', description: 'Human-readable name' },
      description: { type: 'string', description: 'Description of what this intersection represents' },
      members: {
        type: 'array',
        description: 'Array of member roles that compose this intersection',
        items: {
          type: 'object',
          properties: {
            domainCode: { type: 'string', description: 'Domain code (e.g., FUND, SECURITY)' },
            memberRole: { type: 'string', description: 'Role name (e.g., FUND, SECURITY, BORROWER)' },
            isRequired: { type: 'boolean', description: 'Whether this member is required', default: true },
            displayOrder: { type: 'number', description: 'Display order', default: 0 },
          },
          required: ['domainCode', 'memberRole'],
        },
      },
    },
    required: ['intersectionCode', 'intersectionName', 'members'],
  },
  execute: async (args, supabase) => {
    // Insert intersection type
    const { data: type, error: typeError } = await supabase
      .from('intersection_types')
      .insert({
        intersection_code: args.intersectionCode,
        intersection_name: args.intersectionName,
        description: args.description,
      })
      .select()
      .single();

    if (typeError) throw typeError;

    // Insert members
    if (args.members && args.members.length > 0) {
      const membersToInsert = args.members.map((member: any, index: number) => ({
        intersection_type_id: type.id,
        domain_code: member.domainCode,
        member_role: member.memberRole,
        is_required: member.isRequired ?? true,
        display_order: member.displayOrder ?? index,
      }));

      const { error: membersError } = await supabase
        .from('intersection_type_members')
        .insert(membersToInsert);

      if (membersError) throw membersError;
    }

    // Fetch the created type with members
    const { data: createdType, error: fetchError } = await supabase
      .from('intersection_types')
      .select(`
        *,
        intersection_type_members(*)
      `)
      .eq('id', type.id)
      .single();

    if (fetchError) throw fetchError;
    return createdType;
  },
};

const createIntersection: ToolDefinition = {
  name: 'create_intersection',
  description: 'Create a new intersection instance (composite entity). Example: Create a Position by combining a specific Fund and Security.',
  category: 'domain-write',
  inputSchema: {
    type: 'object',
    properties: {
      intersectionCode: { type: 'string', description: 'Unique code for this intersection instance' },
      intersectionTypeCode: { type: 'string', description: 'Type of intersection (e.g., POSITION, LOAN)' },
      members: {
        type: 'array',
        description: 'Array of member entities',
        items: {
          type: 'object',
          properties: {
            entityId: { type: 'string', description: 'Entity ID' },
            memberRole: { type: 'string', description: 'Member role (must match intersection type definition)' },
          },
          required: ['entityId', 'memberRole'],
        },
      },
      attributes: { type: 'object', description: 'Intersection-specific attributes (e.g., quantity, price)' },
      validFrom: { type: 'string', description: 'Valid from date (YYYY-MM-DD)' },
      metadata: { type: 'object', description: 'Additional metadata' },
    },
    required: ['intersectionCode', 'intersectionTypeCode', 'members', 'validFrom'],
  },
  execute: async (args, supabase) => {
    // Get intersection type
    const { data: type, error: typeError } = await supabase
      .from('intersection_types')
      .select('id')
      .eq('intersection_code', args.intersectionTypeCode)
      .single();

    if (typeError) throw typeError;

    // Insert intersection instance
    const { data: intersection, error: intersectionError } = await supabase
      .from('intersection_instances')
      .insert({
        intersection_type_id: type.id,
        intersection_code: args.intersectionCode,
        valid_from: args.validFrom,
        metadata: args.metadata || {},
      })
      .select()
      .single();

    if (intersectionError) throw intersectionError;

    // Insert members
    if (args.members && args.members.length > 0) {
      const membersToInsert = args.members.map((member: any) => ({
        intersection_id: intersection.id,
        entity_id: member.entityId,
        member_role: member.memberRole,
        valid_from: args.validFrom,
      }));

      const { error: membersError } = await supabase
        .from('intersection_members')
        .insert(membersToInsert);

      if (membersError) throw membersError;
    }

    // Insert attributes
    if (args.attributes) {
      for (const [attrCode, value] of Object.entries(args.attributes)) {
        const { data: attr } = await supabase
          .from('attribute_register')
          .select('id, default_precedence_rank')
          .eq('attribute_code', attrCode)
          .single();

        if (attr) {
          const { data: source } = await supabase
            .from('source_registry')
            .select('id')
            .eq('source_code', 'MANUAL')
            .single();

          await supabase.from('intersection_attribute_values').insert({
            intersection_id: intersection.id,
            attribute_id: attr.id,
            source_id: source?.id,
            golden_value: typeof value === 'string' ? value : null,
            golden_value_numeric: typeof value === 'number' ? value : null,
            golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value as string) ? value : null,
            valid_from: args.validFrom,
            precedence_rank: attr.default_precedence_rank,
          });
        }
      }
    }

    // Validate intersection completeness
    const { data: isValid } = await supabase.rpc('validate_intersection_members', {
      p_intersection_id: intersection.id,
    });

    if (!isValid) {
      console.warn(`Intersection ${args.intersectionCode} is missing required members`);
    }

    // Fetch the created intersection
    const { data: createdIntersection, error: fetchError } = await supabase
      .from('intersection_master')
      .select('*')
      .eq('intersection_id', intersection.id)
      .single();

    if (fetchError) throw fetchError;
    return createdIntersection;
  },
};

const listIntersections: ToolDefinition = {
  name: 'list_intersections',
  description: 'List intersection instances (composite entities) with optional filtering.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      intersectionTypeCode: { type: 'string', description: 'Filter by intersection type (e.g., POSITION)' },
      memberEntityId: { type: 'string', description: 'Filter by member entity ID' },
      memberRole: { type: 'string', description: 'Filter by member role' },
      first: { type: 'number', description: 'Number of results to return', default: 20 },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase.from('intersection_master').select('*', { count: 'exact' });

    if (args.intersectionTypeCode) {
      query = query.eq('intersection_type_code', args.intersectionTypeCode);
    }

    if (args.memberEntityId) {
      query = query.contains('members', [{ entity_id: args.memberEntityId }]);
    }

    if (args.memberRole) {
      query = query.contains('members', [{ member_role: args.memberRole }]);
    }

    query = query.limit(args.first || 20);
    const { data, error, count } = await query;

    if (error) throw error;
    return { intersections: data, totalCount: count };
  },
};

const getIntersection: ToolDefinition = {
  name: 'get_intersection',
  description: 'Get a complete intersection instance with all members and attributes.',
  category: 'domain-read',
  inputSchema: {
    type: 'object',
    properties: {
      intersectionId: { type: 'string', description: 'Intersection ID' },
      intersectionCode: { type: 'string', description: 'Intersection code' },
      asOfDate: { type: 'string', description: 'As-of date (YYYY-MM-DD)', default: 'current date' },
    },
  },
  execute: async (args, supabase) => {
    const asOfDate = args.asOfDate || new Date().toISOString().split('T')[0];

    if (args.intersectionCode) {
      // Use the RPC function for complete data
      const { data, error } = await supabase.rpc('get_intersection_full', {
        p_intersection_code: args.intersectionCode,
        p_as_of_date: asOfDate,
      });

      if (error) throw error;
      if (!data) throw new Error('Intersection not found');
      return data;
    } else if (args.intersectionId) {
      const { data, error } = await supabase
        .from('intersection_master')
        .select('*')
        .eq('intersection_id', args.intersectionId)
        .single();

      if (error) throw error;
      return data;
    } else {
      throw new Error('Must provide intersectionId or intersectionCode');
    }
  },
};

const updateIntersection: ToolDefinition = {
  name: 'update_intersection',
  description: 'Update an intersection instance (members and/or attributes).',
  category: 'domain-write',
  inputSchema: {
    type: 'object',
    properties: {
      intersectionId: { type: 'string', description: 'Intersection ID' },
      members: {
        type: 'array',
        description: 'Updated member entities (replaces all existing members)',
        items: {
          type: 'object',
          properties: {
            entityId: { type: 'string', description: 'Entity ID' },
            memberRole: { type: 'string', description: 'Member role' },
          },
          required: ['entityId', 'memberRole'],
        },
      },
      attributes: { type: 'object', description: 'Updated attributes (replaces all existing attributes)' },
      metadata: { type: 'object', description: 'Updated metadata' },
    },
    required: ['intersectionId'],
  },
  execute: async (args, supabase) => {
    const today = new Date().toISOString().split('T')[0];

    // Update metadata
    if (args.metadata !== undefined) {
      const { error: metadataError } = await supabase
        .from('intersection_instances')
        .update({
          metadata: args.metadata,
          updated_at: new Date().toISOString(),
        })
        .eq('id', args.intersectionId);

      if (metadataError) throw metadataError;
    }

    // Update members (bi-temporal: close old, insert new)
    if (args.members) {
      // Close existing members
      await supabase
        .from('intersection_members')
        .update({
          valid_to: today,
          system_to: new Date().toISOString(),
        })
        .eq('intersection_id', args.intersectionId)
        .eq('system_to', '9999-12-31 23:59:59');

      // Insert new members
      const membersToInsert = args.members.map((member: any) => ({
        intersection_id: args.intersectionId,
        entity_id: member.entityId,
        member_role: member.memberRole,
        valid_from: today,
      }));

      if (membersToInsert.length > 0) {
        const { error: membersError } = await supabase
          .from('intersection_members')
          .insert(membersToInsert);

        if (membersError) throw membersError;
      }
    }

    // Update attributes (bi-temporal: close old, insert new)
    if (args.attributes) {
      for (const [attrCode, value] of Object.entries(args.attributes)) {
        const { data: attr } = await supabase
          .from('attribute_register')
          .select('id, default_precedence_rank')
          .eq('attribute_code', attrCode)
          .single();

        if (attr) {
          // Close existing attribute value
          await supabase
            .from('intersection_attribute_values')
            .update({
              valid_to: today,
              system_to: new Date().toISOString(),
            })
            .eq('intersection_id', args.intersectionId)
            .eq('attribute_id', attr.id)
            .eq('system_to', '9999-12-31 23:59:59');

          // Insert new attribute value
          const { data: source } = await supabase
            .from('source_registry')
            .select('id')
            .eq('source_code', 'MANUAL')
            .single();

          await supabase.from('intersection_attribute_values').insert({
            intersection_id: args.intersectionId,
            attribute_id: attr.id,
            source_id: source?.id,
            golden_value: typeof value === 'string' ? value : null,
            golden_value_numeric: typeof value === 'number' ? value : null,
            golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value as string) ? value : null,
            valid_from: today,
            precedence_rank: attr.default_precedence_rank,
          });
        }
      }
    }

    // Fetch the updated intersection
    const { data: updatedIntersection, error: fetchError } = await supabase
      .from('intersection_master')
      .select('*')
      .eq('intersection_id', args.intersectionId)
      .single();

    if (fetchError) throw fetchError;
    return updatedIntersection;
  },
};

const createDomainType: ToolDefinition = {
  name: 'create_domain_type',
  description: 'Create a new domain type (e.g., CASH_FLOW). First step when adding a new entity type.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string' },
      domainName: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['domainCode', 'domainName'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('domain_types')
      .insert({ domain_code: args.domainCode, domain_name: args.domainName, description: args.description })
      .select().single();
    if (error) throw error;
    return data;
  },
};

const createAttribute: ToolDefinition = {
  name: 'create_attribute',
  description: 'Create a new attribute definition in the attribute register.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      attributeCode: { type: 'string' },
      attributeName: { type: 'string' },
      dataType: { type: 'string', description: 'STRING, NUMBER, INTEGER, BOOLEAN, DATE, TIMESTAMP, JSON, CURRENCY, PERCENTAGE' },
      description: { type: 'string' },
      isRequired: { type: 'boolean' },
      isMultiValued: { type: 'boolean' },
      referenceDomainCode: { type: 'string' },
    },
    required: ['attributeCode', 'attributeName', 'dataType'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('attribute_register')
      .insert({
        attribute_code: args.attributeCode, attribute_name: args.attributeName,
        data_type: args.dataType, description: args.description,
        is_required: args.isRequired || false, is_multi_valued: args.isMultiValued || false,
        reference_domain_code: args.referenceDomainCode,
      })
      .select().single();
    if (error) throw error;
    return data;
  },
};

const createTemplate: ToolDefinition = {
  name: 'create_template',
  description: 'Create a new entity template defining which attributes an entity type uses.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      templateCode: { type: 'string' },
      templateName: { type: 'string' },
      domainCode: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['templateCode', 'templateName', 'domainCode'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('domain_templates')
      .insert({ template_code: args.templateCode, template_name: args.templateName, domain_code: args.domainCode, description: args.description })
      .select().single();
    if (error) throw error;
    return data;
  },
};

const assignAttributeToTemplate: ToolDefinition = {
  name: 'assign_attribute_to_template',
  description: 'Assign an attribute to a template, making it part of that entity type.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      templateCode: { type: 'string' },
      attributeCode: { type: 'string' },
      isRequired: { type: 'boolean' },
      displayOrder: { type: 'number' },
    },
    required: ['templateCode', 'attributeCode'],
  },
  execute: async (args, supabase) => {
    const { data: template } = await supabase.from('domain_templates').select('id').eq('template_code', args.templateCode).single();
    const { data: attribute } = await supabase.from('attribute_register').select('id').eq('attribute_code', args.attributeCode).single();
    if (!template || !attribute) throw new Error('Template or attribute not found');
    const { data, error } = await supabase
      .from('template_attribute_assignments')
      .insert({ template_id: template.id, attribute_id: attribute.id, is_required: args.isRequired || false, display_order: args.displayOrder || 0 })
      .select().single();
    if (error) throw error;
    return data;
  },
};

const createEntityIdentifier: ToolDefinition = {
  name: 'create_entity_identifier',
  description: 'Create a unique identifier definition for a domain. Can be single or composite.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string' },
      identifierCode: { type: 'string' },
      identifierName: { type: 'string' },
      attributeCodes: { type: 'array', items: { type: 'string' }, description: 'Attribute codes forming this identifier' },
      isPrimary: { type: 'boolean' },
      description: { type: 'string' },
    },
    required: ['domainCode', 'identifierCode', 'identifierName', 'attributeCodes'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('entity_identifier_definitions')
      .insert({
        domain_code: args.domainCode, identifier_code: args.identifierCode,
        identifier_name: args.identifierName, attribute_codes: args.attributeCodes,
        is_primary: args.isPrimary || false, description: args.description,
      })
      .select().single();
    if (error) throw error;
    return data;
  },
};

const createRelationshipType: ToolDefinition = {
  name: 'create_relationship_type',
  description: 'Create a relationship type between parent and child domains.',
  category: 'domain-admin',
  inputSchema: {
    type: 'object',
    properties: {
      relationshipCode: { type: 'string' },
      relationshipName: { type: 'string' },
      parentDomainCode: { type: 'string' },
      childDomainCode: { type: 'string' },
      cardinality: { type: 'string', description: 'ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, or COMPOSITE' },
      description: { type: 'string' },
    },
    required: ['relationshipCode', 'relationshipName', 'parentDomainCode', 'childDomainCode'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await supabase
      .from('relationship_types')
      .insert({
        relationship_code: args.relationshipCode, relationship_name: args.relationshipName,
        parent_domain_code: args.parentDomainCode, child_domain_code: args.childDomainCode,
        cardinality: args.cardinality || 'ONE_TO_ONE', description: args.description,
      })
      .select().single();
    if (error) throw error;
    return data;
  },
};

export function registerDomainTools(registry: ToolRegistry): void {
  // Metadata tools - essential for agents to understand data context
  registry.registerTool(getAttributeMetadata);
  registry.registerTool(getTemplateMetadata);
  
  // Entity operations
  registry.registerTool(getEntity);
  registry.registerTool(listEntities);
  registry.registerTool(createEntity);
  registry.registerTool(createRelationship);
  registry.registerTool(getRelationshipTypes);
  
  // Admin/setup tools for entity type infrastructure
  registry.registerTool(createDomainType);
  registry.registerTool(createAttribute);
  registry.registerTool(createTemplate);
  registry.registerTool(assignAttributeToTemplate);
  registry.registerTool(createEntityIdentifier);
  registry.registerTool(createRelationshipType);
  
  // Intersection tools
  registry.registerTool(getIntersectionTypes);
  registry.registerTool(createIntersectionType);
  registry.registerTool(createIntersection);
  registry.registerTool(listIntersections);
  registry.registerTool(getIntersection);
  registry.registerTool(updateIntersection);
}
