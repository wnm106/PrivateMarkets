/**
 * Converts an MCP tool's JSON Schema into the schema Gemini function calling
 * accepts.
 *
 * Gemini takes a subset of OpenAPI 3: upper-case types, properties, required,
 * items, string enums, description and nullable. Outside servers send full
 * JSON Schema, so this keeps what Gemini understands and folds the rest into
 * something it accepts:
 *   - `type: ["string", "null"]` becomes `STRING` with `nullable`.
 *   - `anyOf` / `oneOf` keep the first branch that is not null.
 *   - `$ref`, `allOf` and unknown types become a described STRING, so the call
 *     still goes through and the server validates the value.
 *   - `const` becomes a one-value enum; numeric enums become descriptions.
 * Nesting is capped so a recursive schema cannot grow without end.
 */

type Json = Record<string, any>;

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 60;
const MAX_DESCRIPTION = 600;

const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

function describe(schema: Json, extra?: string): string | undefined {
  const parts = [typeof schema.description === 'string' ? schema.description : '', extra || ''].filter(Boolean);
  if (!parts.length) return undefined;
  const text = parts.join(' ');
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

function pickBranch(branches: unknown): Json | null {
  if (!Array.isArray(branches)) return null;
  const usable = branches.filter((b) => b && typeof b === 'object' && b.type !== 'null') as Json[];
  return usable[0] ?? null;
}

function convert(schema: unknown, depth: number): Json {
  if (!schema || typeof schema !== 'object') return { type: 'STRING' };
  const s = schema as Json;

  const branch = pickBranch(s.anyOf) || pickBranch(s.oneOf);
  if (branch) {
    const nullable = [...(s.anyOf || []), ...(s.oneOf || [])].some((b: Json) => b?.type === 'null');
    const merged = convert({ ...branch, description: branch.description ?? s.description }, depth);
    return nullable ? { ...merged, nullable: true } : merged;
  }

  let type = s.type;
  let nullable = s.nullable === true;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes('null');
    type = type.find((t: string) => t !== 'null');
  }
  if (!type) {
    if (s.properties) type = 'object';
    else if (s.items) type = 'array';
    else if (Array.isArray(s.enum)) type = 'string';
  }
  const mapped = typeof type === 'string' ? TYPE_MAP[type.toLowerCase()] : undefined;

  if (!mapped || s.$ref || s.allOf || depth > MAX_DEPTH) {
    const hint = s.$ref || s.allOf ? 'Pass a JSON value as text.' : undefined;
    const out: Json = { type: 'STRING' };
    const description = describe(s, hint);
    if (description) out.description = description;
    if (nullable) out.nullable = true;
    return out;
  }

  const out: Json = { type: mapped };
  if (nullable) out.nullable = true;

  if (s.const !== undefined && mapped === 'STRING') {
    out.enum = [String(s.const)];
  } else if (Array.isArray(s.enum)) {
    if (mapped === 'STRING' && s.enum.every((v: unknown) => typeof v === 'string')) {
      out.enum = s.enum;
    } else {
      out.description = describe(s, `One of: ${s.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}.`);
    }
  }
  if (!out.description) {
    const description = describe(s);
    if (description) out.description = description;
  }

  if (mapped === 'OBJECT') {
    const properties = s.properties && typeof s.properties === 'object' ? Object.entries(s.properties as Json) : [];
    if (properties.length) {
      out.properties = {};
      for (const [key, value] of properties.slice(0, MAX_PROPERTIES)) {
        out.properties[key] = convert(value, depth + 1);
      }
      const required = Array.isArray(s.required)
        ? s.required.filter((k: unknown) => typeof k === 'string' && k in out.properties)
        : [];
      if (required.length) out.required = required;
    }
  } else if (mapped === 'ARRAY') {
    out.items = convert(Array.isArray(s.items) ? s.items[0] : s.items, depth + 1);
  }
  return out;
}

/** The `parameters` of a Gemini function declaration for an MCP tool's input schema. */
export function toGeminiParameters(inputSchema: unknown): Json {
  const converted = convert(inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object' }, 0);
  if (converted.type !== 'OBJECT') return { type: 'OBJECT', properties: { value: converted } };
  return { type: 'OBJECT', properties: converted.properties || {}, ...(converted.required ? { required: converted.required } : {}) };
}
