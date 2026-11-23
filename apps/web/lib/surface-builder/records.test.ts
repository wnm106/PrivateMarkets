import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PROTOTYPE_HTML, blueprintWrite, missingTable, savedFromRow, summaryFromRow } from './records';

describe('blueprintWrite', () => {
  it('needs a name', () => {
    assert.equal(blueprintWrite({ name: '  ' }), 'Give the surface a name before saving.');
    assert.equal(typeof blueprintWrite(null), 'string');
  });

  it('refuses an oversized prototype or a blueprint that is not an object', () => {
    assert.match(String(blueprintWrite({ name: 'X', html: 'a'.repeat(MAX_PROTOTYPE_HTML + 1) })), /limit/);
    assert.equal(blueprintWrite({ name: 'X', blueprint: [1, 2] }), 'The blueprint could not be read.');
  });

  it('maps the draft to columns and keeps only known placements and sources', () => {
    const write = blueprintWrite({
      name: ' Credit watchlist ',
      description: 'Names to watch',
      audience: '',
      domainCode: 'POSITION',
      placement: 'somewhere',
      html: '<p>x</p>',
      blueprint: { source: 'model', fields: [] },
    });
    assert.ok(typeof write === 'object');
    assert.equal(write.surface_name, 'Credit watchlist');
    assert.equal(write.audience, null);
    assert.equal(write.domain_code, 'POSITION');
    assert.equal(write.placement, null);
    assert.equal(write.blueprint_source, 'model');
    assert.equal(blueprintWrite({ name: 'X', placement: 'sdk-surface' }) && (blueprintWrite({ name: 'X', placement: 'sdk-surface' }) as any).placement, 'sdk-surface');
  });
});

describe('rows', () => {
  const row = {
    id: 'a3b1c2d4-0000-4000-8000-000000000001',
    surface_name: 'Credit watchlist',
    description: 'Names',
    audience: null,
    domain_code: 'POSITION',
    placement: 'record-tab',
    prototype_html: '<p>x</p>',
    blueprint: { source: 'baseline' },
    blueprint_source: 'baseline',
    revision: 3,
    updated_at: '2026-11-22T10:00:00Z',
    created_at: '2026-11-21T10:00:00Z',
  };

  it('reads a summary and a full record', () => {
    assert.deepEqual(summaryFromRow(row), {
      id: row.id, name: 'Credit watchlist', description: 'Names', domainCode: 'POSITION', placement: 'record-tab',
      source: 'baseline', revision: 3, updatedAt: row.updated_at, createdAt: row.created_at,
    });
    const saved = savedFromRow(row);
    assert.equal(saved.html, '<p>x</p>');
    assert.deepEqual(saved.blueprint, { source: 'baseline' });
    assert.equal(savedFromRow({ ...row, blueprint: null }).blueprint, null);
  });

  it('recognizes a missing table', () => {
    assert.equal(missingTable('relation "public.surface_blueprints" does not exist'), true);
    assert.equal(missingTable("Could not find the table 'public.surface_blueprints' in the schema cache"), true);
    assert.equal(missingTable('permission denied for table surface_blueprints'), false);
  });
});
