/**
 * Import Map MCP Tools
 * Provides AI agents with tools to analyze and execute data imports
 */

import { ToolRegistry } from '../lib/tool-registry.js';
import { ToolDefinition } from '../lib/types.js';
import { analyzeImportMap, executeImportMap, ImportMap } from '../lib/import-map/import-orchestrator';
import { getIdentifierSuggestions } from '../lib/import-map/identifier-validator';

const analyzeImportMapTool: ToolDefinition = {
  name: 'analyze_import_map',
  description: 'Analyze a data file and generate AI-assisted field mapping recommendations for MDM entities. Parses XLSX, CSV, JSON, HTML, or XML data, extracts field names, recommends entity attribute mappings, validates entity identifiers, and determines import sequencing based on entity relationships.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      sourceData: {
        type: 'string',
        description: 'Base64-encoded data for binary formats (XLSX), or raw string for text formats (CSV, JSON, HTML, XML)',
      },
      sourceFormat: {
        type: 'string',
        enum: ['xlsx', 'csv', 'json', 'html', 'xml'],
        description: 'Format of the source data',
      },
      domainMappings: {
        type: 'array',
        description: 'Array of domain mappings specifying which entities to import',
        items: {
          type: 'object',
          properties: {
            domainCode: { type: 'string', description: 'Domain code (e.g., FUND, ISSUER, SECURITY, DEAL)' },
            templateCode: { type: 'string', description: 'Optional template code' },
            fieldMappings: {
              type: 'array',
              description: 'Pre-defined field mappings (optional, AI will fill in gaps)',
              items: {
                type: 'object',
                properties: {
                  sourceField: { type: 'string' },
                  targetAttribute: { type: 'string' },
                },
                required: ['sourceField', 'targetAttribute'],
              },
            },
          },
          required: ['domainCode'],
        },
      },
      options: {
        type: 'object',
        description: 'Parsing options',
        properties: {
          sheetName: { type: 'string', description: 'Sheet name for XLSX files' },
          delimiter: { type: 'string', description: 'Delimiter for CSV files (default: comma)' },
          tableSelector: { type: 'string', description: 'CSS selector for HTML tables (default: table)' },
          rootElement: { type: 'string', description: 'Root element name for XML files' },
        },
      },
    },
    required: ['sourceData', 'sourceFormat', 'domainMappings'],
  },
  execute: async (args, supabase) => {
    const importMap: ImportMap = {
      name: 'AI Analysis',
      sourceFormat: args.sourceFormat,
      sourceData: args.sourceData,
      domainMappings: args.domainMappings,
      options: args.options,
    };

    const analysis = await analyzeImportMap(importMap, supabase);

    return {
      parsedFields: analysis.parsedData.fields,
      recordCount: analysis.parsedData.recordCount,
      recommendations: analysis.recommendations,
      identifierValidations: analysis.identifierValidations,
      importPlan: analysis.importPlan,
      importBatches: analysis.importBatches,
      overallValidation: analysis.overallValidation,
    };
  },
};

const executeImportMapTool: ToolDefinition = {
  name: 'execute_import_map',
  description: 'Execute a data import using field mappings to create or update MDM entities. Imports data in the correct sequence based on entity relationships (parents first). Supports dry-run mode, batch processing, and error handling options.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      sourceData: {
        type: 'string',
        description: 'Base64-encoded data for binary formats (XLSX), or raw string for text formats (CSV, JSON, HTML, XML)',
      },
      sourceFormat: {
        type: 'string',
        enum: ['xlsx', 'csv', 'json', 'html', 'xml'],
        description: 'Format of the source data',
      },
      domainMappings: {
        type: 'array',
        description: 'Array of domain mappings with field mappings',
        items: {
          type: 'object',
          properties: {
            domainCode: { type: 'string', description: 'Domain code (e.g., FUND, ISSUER, SECURITY, DEAL)' },
            templateCode: { type: 'string', description: 'Optional template code' },
            fieldMappings: {
              type: 'array',
              description: 'Field mappings from source to target attributes',
              items: {
                type: 'object',
                properties: {
                  sourceField: { type: 'string', description: 'Source field name' },
                  targetAttribute: { type: 'string', description: 'Target attribute code' },
                  confidence: { type: 'number', description: 'Mapping confidence (0-1)' },
                  mappingType: { type: 'string', enum: ['exact', 'semantic', 'pattern', 'manual'] },
                },
                required: ['sourceField', 'targetAttribute'],
              },
            },
            relationshipMappings: {
              type: 'array',
              description: 'Relationship mappings to link entities',
              items: {
                type: 'object',
                properties: {
                  relationshipCode: { type: 'string' },
                  parentDomainCode: { type: 'string' },
                  childDomainCode: { type: 'string' },
                  parentKeyField: { type: 'string', description: 'Source field containing parent entity key' },
                  childKeyField: { type: 'string', description: 'Source field containing child entity key' },
                },
                required: ['relationshipCode', 'parentDomainCode', 'childDomainCode', 'parentKeyField', 'childKeyField'],
              },
            },
          },
          required: ['domainCode', 'fieldMappings'],
        },
      },
      options: {
        type: 'object',
        description: 'Import execution options',
        properties: {
          dryRun: { type: 'boolean', description: 'Simulate import without making changes', default: false },
          batchSize: { type: 'number', description: 'Number of records to process per batch', default: 100 },
          skipValidation: { type: 'boolean', description: 'Skip identifier validation', default: false },
          continueOnError: { type: 'boolean', description: 'Continue processing on errors', default: false },
          sheetName: { type: 'string', description: 'Sheet name for XLSX files' },
          delimiter: { type: 'string', description: 'Delimiter for CSV files' },
          tableSelector: { type: 'string', description: 'CSS selector for HTML tables' },
          rootElement: { type: 'string', description: 'Root element name for XML files' },
        },
      },
    },
    required: ['sourceData', 'sourceFormat', 'domainMappings'],
  },
  execute: async (args, supabase) => {
    const importMap: ImportMap = {
      name: 'AI Import',
      sourceFormat: args.sourceFormat,
      sourceData: args.sourceData,
      domainMappings: args.domainMappings,
      options: args.options,
    };

    const result = await executeImportMap(importMap, supabase);

    return result;
  },
};

const getIdentifierSuggestionsTool: ToolDefinition = {
  name: 'get_identifier_suggestions',
  description: 'Get identifier suggestions and recommendations for a domain. Shows what attributes form entity identifiers (e.g., ISIN for Security, LEI for Issuer) and provides recommendations for identifier configuration.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: {
        type: 'string',
        description: 'Domain code (e.g., FUND, ISSUER, SECURITY, DEAL)',
      },
    },
    required: ['domainCode'],
  },
  execute: async (args, supabase) => {
    return getIdentifierSuggestions(args.domainCode, supabase);
  },
};

const parseDataPreviewTool: ToolDefinition = {
  name: 'parse_data_preview',
  description: 'Parse a data file and return a preview of extracted fields, sample values, and inferred data types. Useful for understanding the structure of incoming data before creating field mappings.',
  category: 'import',
  inputSchema: {
    type: 'object',
    properties: {
      sourceData: {
        type: 'string',
        description: 'Base64-encoded data for binary formats (XLSX), or raw string for text formats (CSV, JSON, HTML, XML)',
      },
      sourceFormat: {
        type: 'string',
        enum: ['xlsx', 'csv', 'json', 'html', 'xml'],
        description: 'Format of the source data',
      },
      options: {
        type: 'object',
        description: 'Parsing options',
        properties: {
          sheetName: { type: 'string', description: 'Sheet name for XLSX files' },
          delimiter: { type: 'string', description: 'Delimiter for CSV files' },
          tableSelector: { type: 'string', description: 'CSS selector for HTML tables' },
          rootElement: { type: 'string', description: 'Root element name for XML files' },
        },
      },
    },
    required: ['sourceData', 'sourceFormat'],
  },
  execute: async (args, supabase) => {
    const { parseData } = await import('../lib/import-map/data-parsers.js');
    
    const parsedData = await parseData(
      args.sourceData,
      args.sourceFormat,
      args.options
    );

    return {
      fields: parsedData.fields,
      recordCount: parsedData.recordCount,
      format: parsedData.format,
      sampleRecords: parsedData.records.slice(0, 5), // First 5 records as preview
    };
  },
};

export function registerImportMapTools(registry: ToolRegistry): void {
  registry.registerTool(analyzeImportMapTool);
  registry.registerTool(executeImportMapTool);
  registry.registerTool(getIdentifierSuggestionsTool);
  registry.registerTool(parseDataPreviewTool);
}
