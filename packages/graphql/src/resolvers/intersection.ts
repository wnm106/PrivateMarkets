import { Context } from '../context';

export const intersectionResolvers = {
  Query: {
    intersectionTypes: async (_: any, __: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('intersection_types')
        .select(`
          *,
          intersection_type_members(*)
        `)
        .eq('is_active', true)
        .order('intersection_code');

      if (error) throw error;

      return (data || []).map(mapIntersectionTypeRow);
    },

    intersectionType: async (
      _: any,
      args: { id?: string; intersectionCode?: string },
      context: Context
    ) => {
      let query = context.supabase
        .from('intersection_types')
        .select(`
          *,
          intersection_type_members(*)
        `);

      if (args.id) {
        query = query.eq('id', args.id);
      } else if (args.intersectionCode) {
        query = query.eq('intersection_code', args.intersectionCode);
      } else {
        return null;
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return mapIntersectionTypeRow(data);
    },

    intersections: async (
      _: any,
      args: { filter?: any; pagination?: any; asOfDate?: string },
      context: Context
    ) => {
      const { filter, pagination, asOfDate } = args;
      const asOf = asOfDate || new Date().toISOString().split('T')[0];

      let query = context.supabase
        .from('intersection_master')
        .select('*', { count: 'exact' });

      // Apply filters
      if (filter) {
        if (filter.intersectionTypeCode) {
          query = query.eq('intersection_type_code', filter.intersectionTypeCode);
        }
        if (filter.intersectionCode) {
          query = query.eq('intersection_code', filter.intersectionCode);
        }
        if (filter.memberEntityId) {
          // Filter by member entity - requires JSONB contains
          query = query.contains('members', [{ entity_id: filter.memberEntityId }]);
        }
        if (filter.memberRole) {
          query = query.contains('members', [{ member_role: filter.memberRole }]);
        }
      }

      // Apply pagination
      const limit = pagination?.first || 20;
      const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;

      query = query.range(offset, offset + limit - 1);
      query = query.order('intersection_code');

      const { data, error, count } = await query;

      if (error) throw error;

      const edges = (data || []).map((row: any, index: number) => ({
        node: mapIntersectionRow(row),
        cursor: btoa(String(offset + index)),
      }));

      return {
        edges,
        pageInfo: {
          hasNextPage: (offset + limit) < (count || 0),
          hasPreviousPage: offset > 0,
          startCursor: edges[0]?.cursor,
          endCursor: edges[edges.length - 1]?.cursor,
        },
        totalCount: count || 0,
      };
    },

    intersection: async (
      _: any,
      args: { id?: string; intersectionCode?: string; asOfDate?: string },
      context: Context
    ) => {
      const asOf = args.asOfDate || new Date().toISOString().split('T')[0];

      if (args.intersectionCode) {
        // Query the intersection_master view directly by intersection_code
        const { data, error } = await context.supabase
          .from('intersection_master')
          .select('*')
          .eq('intersection_code', args.intersectionCode)
          .single();

        if (error) {
          if (error.code === 'PGRST116') return null;
          throw error;
        }

        return mapIntersectionRow(data);
      } else if (args.id) {
        // Query by ID from the view
        const { data, error } = await context.supabase
          .from('intersection_master')
          .select('*')
          .eq('intersection_id', args.id)
          .single();

        if (error) {
          if (error.code === 'PGRST116') return null;
          throw error;
        }

        return mapIntersectionRow(data);
      }

      return null;
    },
  },

  Mutation: {
    createIntersectionType: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;

      try {
        // Insert intersection type
        const { data: type, error: typeError } = await context.supabase
          .from('intersection_types')
          .insert({
            intersection_code: input.intersectionCode,
            intersection_name: input.intersectionName,
            description: input.description,
          })
          .select()
          .single();

        if (typeError) throw typeError;

        // Insert members
        if (input.members && input.members.length > 0) {
          const membersToInsert = input.members.map((member: any, index: number) => ({
            intersection_type_id: type.id,
            domain_code: member.domainCode,
            member_role: member.memberRole,
            is_required: member.isRequired ?? true,
            display_order: member.displayOrder ?? index,
          }));

          const { error: membersError } = await context.supabase
            .from('intersection_type_members')
            .insert(membersToInsert);

          if (membersError) throw membersError;
        }

        // Fetch the created type with members
        const { data: createdType } = await context.supabase
          .from('intersection_types')
          .select(`
            *,
            intersection_type_members(*)
          `)
          .eq('id', type.id)
          .single();

        return {
          intersectionType: mapIntersectionTypeRow(createdType),
          errors: [],
        };
      } catch (error: any) {
        return {
          intersectionType: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    updateIntersectionType: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;

      try {
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        if (input.intersectionName !== undefined) updateData.intersection_name = input.intersectionName;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;

        const { data, error } = await context.supabase
          .from('intersection_types')
          .update(updateData)
          .eq('id', input.id)
          .select('*')
          .single();

        if (error) throw error;

        // Sync members: delete existing and re-insert
        if (input.members !== undefined) {
          // Delete all existing members for this type
          await context.supabase
            .from('intersection_type_members')
            .delete()
            .eq('intersection_type_id', input.id);

          // Insert new members
          if (input.members.length > 0) {
            const membersToInsert = input.members.map((member: any, index: number) => ({
              intersection_type_id: input.id,
              domain_code: member.domainCode,
              member_role: member.memberRole,
              is_required: member.isRequired ?? true,
              display_order: member.displayOrder ?? index,
            }));

            const { error: membersError } = await context.supabase
              .from('intersection_type_members')
              .insert(membersToInsert);

            if (membersError) throw membersError;
          }
        }

        // Fetch the updated type with members
        const { data: updatedType } = await context.supabase
          .from('intersection_types')
          .select(`
            *,
            intersection_type_members(*)
          `)
          .eq('id', input.id)
          .single();

        return {
          intersectionType: mapIntersectionTypeRow(updatedType),
          errors: [],
        };
      } catch (error: any) {
        return {
          intersectionType: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    deleteIntersectionType: async (
      _: any,
      args: { id: string },
      context: Context
    ) => {
      try {
        // Check if any intersections use this type
        const { count } = await context.supabase
          .from('intersection_instances')
          .select('id', { count: 'exact', head: true })
          .eq('intersection_type_id', args.id)
          .eq('system_to', '9999-12-31 23:59:59');

        if ((count || 0) > 0) {
          return {
            success: false,
            errors: [
              {
                field: '',
                message: `Cannot delete intersection type — it is currently used by ${count} intersection${count === 1 ? '' : 's'}.`,
                code: 'IN_USE',
              },
            ],
          };
        }

        const { error } = await context.supabase
          .from('intersection_types')
          .delete()
          .eq('id', args.id);

        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },

    createIntersection: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      const userId = context.user?.id;

      try {
        // Get intersection type
        const { data: type, error: typeError } = await context.supabase
          .from('intersection_types')
          .select('id')
          .eq('intersection_code', input.intersectionTypeCode)
          .single();

        if (typeError) throw typeError;

        // Insert intersection instance
        const { data: intersection, error: intersectionError } = await context.supabase
          .from('intersection_instances')
          .insert({
            intersection_type_id: type.id,
            intersection_code: input.intersectionCode,
            valid_from: input.validFrom,
            metadata: input.metadata || {},
            created_by: userId,
          })
          .select()
          .single();

        if (intersectionError) throw intersectionError;

        // Insert members
        if (input.members && input.members.length > 0) {
          const membersToInsert = input.members.map((member: any) => ({
            intersection_id: intersection.id,
            entity_id: member.entityId,
            member_role: member.memberRole,
            valid_from: input.validFrom,
          }));

          const { error: membersError } = await context.supabase
            .from('intersection_members')
            .insert(membersToInsert);

          if (membersError) throw membersError;
        }

        // Insert attributes
        if (input.attributes) {
          for (const [attrCode, value] of Object.entries(input.attributes)) {
            const { data: attr } = await context.supabase
              .from('attribute_register')
              .select('id, default_precedence_rank')
              .eq('attribute_code', attrCode)
              .single();

            if (attr) {
              const { data: source } = await context.supabase
                .from('source_registry')
                .select('id')
                .eq('source_code', 'MANUAL')
                .single();

              await context.supabase.from('intersection_attribute_values').insert({
                intersection_id: intersection.id,
                attribute_id: attr.id,
                source_id: source?.id,
                golden_value: typeof value === 'string' ? value : null,
                golden_value_numeric: typeof value === 'number' ? value : null,
                golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
                valid_from: input.validFrom,
                precedence_rank: attr.default_precedence_rank,
                created_by: userId,
              });
            }
          }
        }

        // Validate intersection completeness
        const { data: isValid } = await context.supabase.rpc('validate_intersection_members', {
          p_intersection_id: intersection.id,
        });

        if (!isValid) {
          console.warn(`Intersection ${input.intersectionCode} is missing required members`);
        }

        // Fetch the created intersection
        const { data: createdIntersection } = await context.supabase
          .from('intersection_master')
          .select('*')
          .eq('intersection_id', intersection.id)
          .single();

        return {
          intersection: createdIntersection ? mapIntersectionRow(createdIntersection) : null,
          errors: [],
        };
      } catch (error: any) {
        return {
          intersection: null,
          errors: [{ field: '', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    updateIntersection: async (
      _: any,
      args: { input: any },
      context: Context
    ) => {
      const { input } = args;
      const userId = context.user?.id;
      const today = new Date().toISOString().split('T')[0];

      try {
        // Update metadata
        if (input.metadata !== undefined) {
          const { error: metadataError } = await context.supabase
            .from('intersection_instances')
            .update({
              metadata: input.metadata,
              updated_by: userId,
              updated_at: new Date().toISOString(),
            })
            .eq('id', input.id);

          if (metadataError) throw metadataError;
        }

        // Update members (bi-temporal: close old, insert new)
        if (input.members) {
          // Close existing members
          await context.supabase
            .from('intersection_members')
            .update({
              valid_to: today,
              system_to: new Date().toISOString(),
            })
            .eq('intersection_id', input.id)
            .eq('system_to', '9999-12-31 23:59:59');

          // Insert new members
          const membersToInsert = input.members.map((member: any) => ({
            intersection_id: input.id,
            entity_id: member.entityId,
            member_role: member.memberRole,
            valid_from: today,
          }));

          if (membersToInsert.length > 0) {
            const { error: membersError } = await context.supabase
              .from('intersection_members')
              .insert(membersToInsert);

            if (membersError) throw membersError;
          }
        }

        // Update attributes (bi-temporal: close old, insert new)
        if (input.attributes) {
          for (const [attrCode, value] of Object.entries(input.attributes)) {
            const { data: attr } = await context.supabase
              .from('attribute_register')
              .select('id, default_precedence_rank')
              .eq('attribute_code', attrCode)
              .single();

            if (attr) {
              // Close existing attribute value
              await context.supabase
                .from('intersection_attribute_values')
                .update({
                  valid_to: today,
                  system_to: new Date().toISOString(),
                })
                .eq('intersection_id', input.id)
                .eq('attribute_id', attr.id)
                .eq('system_to', '9999-12-31 23:59:59');

              // Insert new attribute value
              const { data: source } = await context.supabase
                .from('source_registry')
                .select('id')
                .eq('source_code', 'MANUAL')
                .single();

              await context.supabase.from('intersection_attribute_values').insert({
                intersection_id: input.id,
                attribute_id: attr.id,
                source_id: source?.id,
                golden_value: typeof value === 'string' ? value : null,
                golden_value_numeric: typeof value === 'number' ? value : null,
                golden_value_date: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null,
                valid_from: today,
                precedence_rank: attr.default_precedence_rank,
                created_by: userId,
              });
            }
          }
        }

        // Fetch the updated intersection
        const { data: updatedIntersection } = await context.supabase
          .from('intersection_master')
          .select('*')
          .eq('intersection_id', input.id)
          .single();

        return {
          intersection: updatedIntersection ? mapIntersectionRow(updatedIntersection) : null,
          errors: [],
        };
      } catch (error: any) {
        return {
          intersection: null,
          errors: [{ field: '', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    deleteIntersection: async (
      _: any,
      args: { id: string },
      context: Context
    ) => {
      try {
        // Delete will cascade to members and attributes
        const { error } = await context.supabase
          .from('intersection_instances')
          .delete()
          .eq('id', args.id);

        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: '', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },
  },
};

function mapIntersectionTypeRow(row: any): any {
  return {
    id: row.id,
    intersectionCode: row.intersection_code,
    intersectionName: row.intersection_name,
    description: row.description,
    isActive: row.is_active,
    members: (row.intersection_type_members || []).map((member: any) => ({
      id: member.id,
      intersectionTypeId: member.intersection_type_id,
      domainCode: member.domain_code,
      memberRole: member.member_role,
      isRequired: member.is_required,
      displayOrder: member.display_order,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function mapIntersectionRow(row: any): any {
  return {
    id: row.intersection_id,
    intersectionCode: row.intersection_code,
    intersectionTypeCode: row.intersection_type_code,
    intersectionTypeName: row.intersection_type_name,
    members: (row.members || []).map((member: any) => ({
      memberRole: member.member_role,
      entityId: member.entity_id,
      entityCode: member.entity_code,
      entityName: member.entity_name,
      domainCode: member.domain_code,
    })),
    attributes: row.attributes || {},
    validFrom: row.valid_from,
    validTo: row.valid_to,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIntersectionFullRow(data: any): any {
  return {
    id: data.intersection_id,
    intersectionCode: data.intersection_code,
    intersectionTypeCode: data.intersection_type_code,
    intersectionTypeName: data.intersection_type_name,
    members: (data.members || []).map((member: any) => ({
      memberRole: member.member_role,
      entityId: member.entity_id,
      entityCode: member.entity_code,
      entityName: member.entity_name,
      domainCode: member.domain_code,
    })),
    attributes: data.attributes || {},
    validFrom: data.valid_from,
    validTo: data.valid_to,
    metadata: data.metadata,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}
