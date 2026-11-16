import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColDef } from 'ag-grid-community';
import { columnSearchFilterParams, likeSearchModel, prepareGridColumns, textFromColumnFilter } from './grid-filters';

describe('column search', () => {
  it('starts the value list with nothing checked so one choice stays selected', () => {
    const params = columnSearchFilterParams();
    const setFilter = params.filters?.[1];
    assert.equal(setFilter?.filter, 'agSetColumnFilter');
    assert.equal(setFilter?.filterParams.defaultToNothingSelected, true);
    assert.equal(setFilter?.filterParams.suppressClearModelOnRefreshValues, true);
    assert.equal(params.filters?.[0]?.filter, 'agTextColumnFilter');
    assert.deepEqual(params.filters?.[0]?.filterParams.filterOptions, ['contains']);
  });

  it('applies a contains search without clearing the checked values', () => {
    const current = {
      filterType: 'multi',
      filterModels: [null, { filterType: 'set', values: ['DEAL_FACILITY_SIZE'] }],
    };
    const next = likeSearchModel(current, 'deal_fa');
    assert.deepEqual(next, {
      filterType: 'multi',
      filterModels: [
        { filterType: 'text', type: 'contains', filter: 'deal_fa' },
        { filterType: 'set', values: ['DEAL_FACILITY_SIZE'] },
      ],
    });
    assert.equal(textFromColumnFilter(next), 'deal_fa');
  });

  it('clears a contains search and keeps the checked value', () => {
    const current = {
      filterType: 'multi',
      filterModels: [
        { filterType: 'text', type: 'contains', filter: 'deal_fa' },
        { filterType: 'set', values: ['DEAL_FACILITY_SIZE'] },
      ],
    };
    const next = likeSearchModel(current, '');
    assert.deepEqual(next?.filterModels[0], null);
    assert.deepEqual(next?.filterModels[1], { filterType: 'set', values: ['DEAL_FACILITY_SIZE'] });
  });

  it('removes the column filter when the search and the value list are both empty', () => {
    assert.equal(likeSearchModel(null, ''), null);
    assert.equal(textFromColumnFilter(null), '');
  });
});

describe('prepareGridColumns', () => {
  const columns: ColDef[] = [
    { colId: 'select', headerName: '', filter: false },
    { field: 'attributeName', headerName: 'Name' },
    { field: 'rowCount', headerName: 'Rows', filter: 'agNumberColumnFilter' },
    { colId: 'actions', headerName: 'Actions', filter: false },
  ];

  it('adds a contains box and a value list to columns that use the standard filter', () => {
    const [select, name, rows, actions] = prepareGridColumns(columns, true);
    assert.equal(select.filter, false);
    assert.equal(select.floatingFilter, undefined);
    assert.equal(name.filter, 'agMultiColumnFilter');
    assert.equal(name.floatingFilter, true);
    assert.equal(name.enableRowGroup, true);
    assert.equal((name.filterParams as { filters: Array<{ filter: string }> }).filters[0].filter, 'agTextColumnFilter');
    assert.equal(rows.filter, 'agNumberColumnFilter');
    assert.equal(rows.filterParams, undefined);
    assert.equal(actions.filter, false);
  });

  it('leaves filters off when the grid asks for that', () => {
    const [, name] = prepareGridColumns(columns, false);
    assert.equal(name.filter, undefined);
    assert.equal(name.enableRowGroup, true);
  });
});
