import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColDef } from 'ag-grid-community';
import { columnSearchFilterParams, likeSearchModel, prepareGridColumns, textContainsFilterParams, textFromColumnFilter } from './grid-filters';

describe('column search', () => {
  it('keeps a contains search and a value pick list', () => {
    const params = columnSearchFilterParams();
    const text = params.filters?.[0];
    const values = params.filters?.[1];
    assert.equal(text?.filter, 'agTextColumnFilter');
    assert.equal(text?.display, 'inline');
    assert.deepEqual(text?.filterParams, textContainsFilterParams());
    assert.equal(values?.filter, 'agSetColumnFilter');
    assert.equal(values?.display, 'inline');
    assert.equal(values?.filterParams.defaultToNothingSelected, true);
    assert.equal(values?.filterParams.suppressClearModelOnRefreshValues, true);
  });

  it('applies a contains search without clearing the checked values', () => {
    const current = {
      filterType: 'multi',
      filterModels: [null, { filterType: 'set', values: ['Industrial Machinery'] }],
    };
    const next = likeSearchModel(current, 'ind');
    assert.deepEqual(next, {
      filterType: 'multi',
      filterModels: [
        { filterType: 'text', type: 'contains', filter: 'ind' },
        { filterType: 'set', values: ['Industrial Machinery'] },
      ],
    });
    assert.equal(textFromColumnFilter(next), 'ind');
  });

  it('clears a contains search and keeps the checked value', () => {
    const current = {
      filterType: 'multi',
      filterModels: [
        { filterType: 'text', type: 'contains', filter: 'ind' },
        { filterType: 'set', values: ['Industrial Machinery'] },
      ],
    };
    const next = likeSearchModel(current, '');
    assert.deepEqual(next?.filterModels[0], null);
    assert.deepEqual(next?.filterModels[1], { filterType: 'set', values: ['Industrial Machinery'] });
  });

  it('removes the column filter when the search and the pick list are both empty', () => {
    assert.equal(likeSearchModel(null, ''), null);
    assert.equal(textFromColumnFilter(null), '');
  });
});

describe('prepareGridColumns', () => {
  const columns: ColDef[] = [
    { colId: 'select', headerName: '', filter: false },
    { field: 'attributeName', headerName: 'Name' },
    { field: 'country', headerName: 'Country', filter: 'agTextColumnFilter' },
    { field: 'rowCount', headerName: 'Rows', filter: 'agNumberColumnFilter' },
    { colId: 'actions', headerName: 'Actions', filter: false },
  ];

  it('gives string columns a contains search and a value pick list', () => {
    const [select, name, country, rows, actions] = prepareGridColumns(columns, true);
    assert.equal(select.filter, false);
    assert.equal(select.floatingFilter, undefined);
    assert.equal(name.filter, 'agMultiColumnFilter');
    assert.equal(name.floatingFilter, true);
    assert.equal(name.enableRowGroup, true);
    assert.equal((name.filterParams as { filters: Array<{ filter: string }> }).filters[1].filter, 'agSetColumnFilter');
    assert.equal(country.filter, 'agMultiColumnFilter');
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
