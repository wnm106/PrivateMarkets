/**
 * Saved Surface Builder blueprints: the stored row, what the API returns, and
 * the check on what a caller may save. Shared by the routes and the page.
 */
import type { SurfaceBlueprint, SurfaceRequest } from './blueprint';

export const MAX_PROTOTYPE_HTML = 400_000;
/** A stored blueprint is capped so one save cannot hold an unbounded document. */
export const MAX_BLUEPRINT_JSON = 2_000_000;

export const BLUEPRINT_LIST_COLUMNS = 'id, surface_name, description, domain_code, placement, blueprint_source, revision, updated_at, created_at';

export interface SavedBlueprintSummary {
  id: string;
  name: string;
  description: string;
  domainCode: string | null;
  placement: SurfaceRequest['placement'] | null;
  source: SurfaceBlueprint['source'] | null;
  revision: number;
  updatedAt: string;
  createdAt: string;
}

export interface SavedBlueprint extends SavedBlueprintSummary {
  audience: string | null;
  html: string;
  blueprint: SurfaceBlueprint | null;
}

type Row = Record<string, any>;

export function summaryFromRow(row: Row): SavedBlueprintSummary {
  return {
    id: String(row.id),
    name: String(row.surface_name || ''),
    description: String(row.description || ''),
    domainCode: row.domain_code ?? null,
    placement: row.placement ?? null,
    source: row.blueprint_source ?? null,
    revision: Number(row.revision) || 1,
    updatedAt: String(row.updated_at || ''),
    createdAt: String(row.created_at || ''),
  };
}

export function savedFromRow(row: Row): SavedBlueprint {
  return {
    ...summaryFromRow(row),
    audience: row.audience ?? null,
    html: String(row.prototype_html || ''),
    blueprint: row.blueprint && typeof row.blueprint === 'object' ? (row.blueprint as SurfaceBlueprint) : null,
  };
}

export interface BlueprintWrite {
  surface_name: string;
  description: string;
  audience: string | null;
  domain_code: string | null;
  placement: string | null;
  prototype_html: string;
  blueprint: SurfaceBlueprint | null;
  blueprint_source: string | null;
}

const PLACEMENTS = ['record-tab', 'sdk-surface', 'app-page'];

/** The columns to write for a save, or the reason the save is refused. */
export function blueprintWrite(body: unknown): BlueprintWrite | string {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
  if (!name) return 'Give the surface a name before saving.';
  const html = typeof input.html === 'string' ? input.html : '';
  if (html.length > MAX_PROTOTYPE_HTML) return `The prototype is ${Math.round(html.length / 1000)}KB; the limit is ${MAX_PROTOTYPE_HTML / 1000}KB.`;

  let blueprint: SurfaceBlueprint | null = null;
  if (input.blueprint != null) {
    if (typeof input.blueprint !== 'object' || Array.isArray(input.blueprint)) return 'The blueprint could not be read.';
    const size = JSON.stringify(input.blueprint).length;
    if (size > MAX_BLUEPRINT_JSON) return `The blueprint is ${Math.round(size / 1000)}KB; the limit is ${MAX_BLUEPRINT_JSON / 1000}KB.`;
    blueprint = input.blueprint as SurfaceBlueprint;
  }
  const source = blueprint?.source === 'model' || blueprint?.source === 'baseline' ? blueprint.source : null;
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

  return {
    surface_name: name,
    description: text(input.description, 6000) || '',
    audience: text(input.audience, 1000),
    domain_code: text(input.domainCode, 50),
    placement: typeof input.placement === 'string' && PLACEMENTS.includes(input.placement) ? input.placement : null,
    prototype_html: html,
    blueprint,
    blueprint_source: source,
  };
}

/** Whether a database error means the table has not been created yet. */
export function missingTable(message: string | undefined): boolean {
  return /surface_blueprints/.test(message || '') && /(does not exist|schema cache|could not find)/i.test(message || '');
}

export const MISSING_TABLE_TEXT = 'Saved blueprints are not in the database yet. Apply the surface_blueprints migration, then reload.';
