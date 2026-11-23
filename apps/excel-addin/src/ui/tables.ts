import type { ExcelAuth } from '../lib/auth';
import type { GraphQLClient } from '../lib/graphql';
import {
  BUILT_IN_COLUMNS,
  FILTER_OPS,
  kindForDataType,
  type FieldKind,
  type FilterOp,
  type TableColumn,
  type TableDefinition,
  type TableFilter,
} from '../lib/tables';
import { errorResult } from '../lib/tap-client';
import type { TableSync } from '../office/table-sync';
import { selectedAddress } from '../office/tables';
import { h } from './dom';

/**
 * Tables: bring the records of one entity type into Excel, filtered on the way in.
 * A filter value is typed, or points at a cell with "=B2"; with auto-refresh on,
 * changing that cell refreshes the table.
 */

const DOMAIN_TYPES_QUERY = `query TapDomainTypes { domainTypes { domainCode domainName isActive } }`;
const ATTRIBUTES_QUERY = `query TapAttributes($domainCode: String) {
  attributeRegister(domainCode: $domainCode) { attributeCode attributeName dataType isVisible }
}`;

interface Deps {
  auth: ExcelAuth;
  graphql: GraphQLClient;
  sync: TableSync;
  setStatus: (text: string, tone?: 'info' | 'error') => void;
}

interface Field {
  code: string;
  label: string;
  kind: FieldKind;
}

const OPS_WITHOUT_VALUE: FilterOp[] = ['isNull', 'notNull'];

function message(error: unknown): string {
  const result = errorResult(error);
  return result.ok ? '' : result.message;
}

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const element = h('option', { value }, [label]);
  if (selected) element.selected = true;
  return element;
}

export function mountTables(container: HTMLElement, deps: Deps): void {
  const { auth, graphql, sync } = deps;
  const list = h('div', { className: 'table-list' });
  const form = h('div', { className: 'table-form', hidden: true });
  const newButton = h('button', { type: 'button', className: 'primary' }, ['New table']);
  const refreshAllButton = h('button', { type: 'button' }, ['Refresh all']);

  let domains: Array<{ domainCode: string; domainName: string }> | null = null;
  const fieldsByDomain = new Map<string, Field[]>();

  const loadDomains = async () => {
    if (domains) return domains;
    const data = await graphql.request<{ domainTypes: Array<{ domainCode: string; domainName: string; isActive: boolean }> }>(DOMAIN_TYPES_QUERY);
    domains = data.domainTypes.filter((item) => item.isActive !== false).sort((a, b) => a.domainName.localeCompare(b.domainName));
    return domains;
  };

  const loadFields = async (domainCode: string): Promise<Field[]> => {
    const cached = fieldsByDomain.get(domainCode);
    if (cached) return cached;
    const data = await graphql.request<{ attributeRegister: Array<{ attributeCode: string; attributeName: string; dataType: string; isVisible: boolean }> }>(ATTRIBUTES_QUERY, { domainCode });
    const fields = [
      ...BUILT_IN_COLUMNS.map((column) => ({ code: column.code, label: column.label, kind: column.kind })),
      ...data.attributeRegister
        .filter((attribute) => attribute.isVisible !== false)
        .map((attribute) => ({ code: attribute.attributeCode, label: attribute.attributeName || attribute.attributeCode, kind: kindForDataType(attribute.dataType) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    fieldsByDomain.set(domainCode, fields);
    return fields;
  };

  // ---------------------------------------------------------------- the list

  const confirmingStop = new Set<string>();

  const renderList = () => {
    const tables = sync.list();
    if (!tables.length) {
      list.replaceChildren(h('p', { className: 'help' }, ['No tables in this workbook yet.']));
    } else {
      list.replaceChildren(...tables.map((table) => {
        const status = sync.status(table.tableName);
        const auto = h('input', { type: 'checkbox', 'aria-label': `Auto-refresh ${table.tableName}` });
        auto.checked = table.autoRefresh;
        auto.addEventListener('change', () => { void sync.setAutoRefresh(table.tableName, auto.checked); });
        const stopLabel = confirmingStop.has(table.tableName) ? 'Stop syncing? Click again' : 'Stop syncing';
        // The status line says how the last refresh in this session went; before one, the saved count and time stand in.
        const meta = [
          `${table.columns.length} columns`,
          table.filters.length ? `${table.filters.length} filter${table.filters.length === 1 ? '' : 's'}` : 'no filters',
          !status.message && table.rowCount !== undefined ? `${table.rowCount.toLocaleString()} rows` : null,
          !status.message && table.lastRefreshed ? `refreshed ${new Date(table.lastRefreshed).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : null,
        ].filter(Boolean).join(' · ');
        return h('div', { className: 'table-item' }, [
          h('div', { className: 'override-head' }, [h('span', { className: 'code' }, [table.tableName]), h('span', {}, [table.domainName])]),
          h('p', { className: 'override-now' }, [meta]),
          status.message ? h('p', { className: `override-status ${status.state === 'error' ? 'error' : status.state === 'ok' ? 'ok' : 'muted'}` }, [status.message]) : null,
          h('label', { className: 'inline' }, [auto, ' Refresh when a filter cell changes']),
          h('div', { className: 'actions' }, [
            h('button', { type: 'button', disabled: status.state === 'working', onClick: () => { void sync.refresh(table.tableName); } }, ['Refresh']),
            h('button', { type: 'button', onClick: () => { void openForm(table); } }, ['Edit']),
            h('button', {
              type: 'button',
              onClick: () => {
                if (!confirmingStop.has(table.tableName)) { confirmingStop.add(table.tableName); renderList(); return; }
                confirmingStop.delete(table.tableName);
                void sync.stop(table.tableName).then(() => deps.setStatus(`${table.tableName} is now an ordinary table. Its values stay.`));
              },
            }, [stopLabel]),
          ]),
        ]);
      }));
    }
    refreshAllButton.disabled = !tables.length;
  };

  // ---------------------------------------------------------------- the form

  const openForm = async (editing?: TableDefinition) => {
    if (!auth.email()) {
      deps.setStatus('Sign in to add a table.', 'error');
      return;
    }
    form.hidden = false;
    form.replaceChildren(h('p', { className: 'help' }, ['Loading…']));
    let domainList: Array<{ domainCode: string; domainName: string }>;
    try {
      domainList = await loadDomains();
    } catch (error) {
      form.replaceChildren(h('p', { className: 'override-status error' }, [message(error)]));
      return;
    }

    const domainSelect = h('select', { id: 'table-domain', disabled: Boolean(editing) });
    domainSelect.append(option('', 'Choose an entity type'), ...domainList.map((item) => option(item.domainCode, item.domainName, item.domainCode === editing?.domainCode)));
    const columnSearch = h('input', { type: 'search', placeholder: 'Find attributes to add', autocomplete: 'off' });
    const chosenList = h('div', { className: 'chips' });
    const picker = h('div', { className: 'results column-picker' });
    const filterRows = h('div', { className: 'filter-rows' });
    const addFilter = h('button', { type: 'button' }, ['Add filter']);
    const asOf = h('input', { type: 'text', placeholder: 'Blank for today, a date, or =B1', value: editing?.asOf || '' });
    const sortField = h('select', { 'aria-label': 'Sort by' });
    const sortDir = h('select', { 'aria-label': 'Sort direction' });
    sortDir.append(option('asc', 'ascending', editing?.sort[0]?.dir !== 'desc'), option('desc', 'descending', editing?.sort[0]?.dir === 'desc'));
    const auto = h('input', { type: 'checkbox' });
    auto.checked = editing ? editing.autoRefresh : true;
    const save = h('button', { type: 'button', className: 'primary' }, [editing ? 'Save and refresh' : 'Insert at selected cell']);
    const cancel = h('button', { type: 'button' }, ['Cancel']);
    const formStatus = h('p', { className: 'override-summary', 'aria-live': 'polite' });

    let fields: Field[] = [];
    let chosen: TableColumn[] = editing ? editing.columns.filter((column) => !BUILT_IN_COLUMNS.some((built) => built.code === column.code)) : [];

    const fieldOptions = (select: HTMLSelectElement, value: string, blank?: string) => {
      select.replaceChildren(...(blank !== undefined ? [option('', blank, !value)] : []), ...fields.map((field) => option(field.code, field.label, field.code === value)));
    };

    const renderChosen = () => {
      chosenList.replaceChildren(
        ...BUILT_IN_COLUMNS.map((column) => h('span', { className: 'chip fixed' }, [column.label])),
        ...chosen.map((column) => h('span', { className: 'chip' }, [
          column.label,
          h('button', { type: 'button', 'aria-label': `Remove ${column.label}`, onClick: () => { chosen = chosen.filter((item) => item.code !== column.code); renderChosen(); renderPicker(); } }, ['×']),
        ])),
      );
    };

    const renderPicker = () => {
      const query = columnSearch.value.trim().toLowerCase();
      const available = fields
        .filter((field) => !BUILT_IN_COLUMNS.some((built) => built.code === field.code))
        .filter((field) => !chosen.some((column) => column.code === field.code))
        .filter((field) => !query || field.label.toLowerCase().includes(query) || field.code.toLowerCase().includes(query))
        .slice(0, 40);
      picker.replaceChildren(...available.map((field) => h('button', {
        type: 'button',
        className: 'choice',
        onClick: () => { chosen.push({ code: field.code, label: field.label, kind: field.kind }); renderChosen(); renderPicker(); },
      }, [h('span', { className: 'code' }, [field.code]), h('span', { className: 'label' }, [field.label])])));
    };

    const filterRow = (filter?: TableFilter) => {
      const field = h('select', { 'aria-label': 'Filter field' });
      fieldOptions(field, filter?.field || 'entity_code');
      const op = h('select', { 'aria-label': 'Filter operator' });
      op.append(...FILTER_OPS.map((item) => option(item.op, item.label, item.op === (filter?.op || 'eq'))));
      const value = h('input', { type: 'text', placeholder: 'Value, or =B2 for a cell', value: filter?.value || '', 'aria-label': 'Filter value' });
      const useCell = h('button', { type: 'button', title: 'Use the selected cell' }, ['Cell']);
      const remove = h('button', { type: 'button', 'aria-label': 'Remove filter' }, ['×']);
      const row = h('div', { className: 'filter-row' }, [
        h('div', { className: 'filter-line' }, [field, op]),
        h('div', { className: 'filter-line' }, [value, useCell, remove]),
      ]);
      const syncOp = () => { value.disabled = OPS_WITHOUT_VALUE.includes(op.value as FilterOp); useCell.disabled = value.disabled; };
      op.addEventListener('change', syncOp);
      syncOp();
      useCell.addEventListener('click', () => { void selectedAddress().then(({ sheet, address }) => { value.value = `=${sheet ? `'${sheet.replace(/'/g, "''")}'!` : ''}${address}`; }); });
      remove.addEventListener('click', () => row.remove());
      filterRows.append(row);
    };

    const readFilters = (): TableFilter[] => [...filterRows.querySelectorAll('.filter-row')].map((row) => {
      const [field, op] = row.querySelectorAll('select');
      const value = row.querySelector('input') as HTMLInputElement;
      const definition = fields.find((item) => item.code === field.value);
      return { field: field.value, op: op.value as FilterOp, value: OPS_WITHOUT_VALUE.includes(op.value as FilterOp) ? '' : value.value, kind: definition?.kind, label: definition?.label };
    }).filter((filter) => filter.field);

    const loadDomain = async (domainCode: string) => {
      if (!domainCode) { fields = []; picker.replaceChildren(); return; }
      formStatus.textContent = 'Loading attributes…';
      try {
        fields = await loadFields(domainCode);
        formStatus.textContent = '';
      } catch (error) {
        formStatus.textContent = message(error);
        return;
      }
      fieldOptions(sortField, editing?.sort[0]?.field || '', 'No sort');
      filterRows.replaceChildren();
      for (const filter of editing?.filters || []) filterRow(filter);
      renderChosen();
      renderPicker();
    };

    domainSelect.addEventListener('change', () => { chosen = []; void loadDomain(domainSelect.value); });
    columnSearch.addEventListener('input', renderPicker);
    addFilter.addEventListener('click', () => { if (fields.length) filterRow(); });
    cancel.addEventListener('click', () => { form.hidden = true; form.replaceChildren(); });
    save.addEventListener('click', () => {
      const domainCode = domainSelect.value;
      if (!domainCode) { formStatus.textContent = 'Choose an entity type.'; return; }
      const draft: Omit<TableDefinition, 'tableName'> = {
        domainCode,
        domainName: domainList.find((item) => item.domainCode === domainCode)?.domainName || domainCode,
        columns: [...BUILT_IN_COLUMNS, ...chosen],
        filters: readFilters(),
        asOf: asOf.value.trim(),
        sort: sortField.value ? [{ field: sortField.value, dir: sortDir.value === 'desc' ? 'desc' : 'asc' }] : [],
        autoRefresh: auto.checked,
      };
      save.disabled = true;
      formStatus.textContent = editing ? 'Saving…' : 'Inserting…';
      const done = editing
        ? sync.update(editing.tableName, draft).then(() => editing.tableName)
        : selectedAddress().then((anchor) => sync.create(draft, anchor)).then((table) => table.tableName);
      done.then((name) => {
        form.hidden = true;
        form.replaceChildren();
        deps.setStatus(`${name} is synced.`);
      }).catch((error) => {
        formStatus.textContent = error instanceof Error ? error.message : message(error);
      }).finally(() => { save.disabled = false; });
    });

    const asOfCell = h('button', { type: 'button', title: 'Use the selected cell' }, ['Cell']);
    asOfCell.addEventListener('click', () => { void selectedAddress().then(({ sheet, address }) => { asOf.value = `=${sheet ? `'${sheet.replace(/'/g, "''")}'!` : ''}${address}`; }); });

    form.replaceChildren(
      h('h3', {}, [editing ? `Edit ${editing.tableName}` : 'New table']),
      h('label', { for: 'table-domain' }, ['Records of']),
      domainSelect,
      h('label', {}, ['Columns']),
      chosenList,
      columnSearch,
      picker,
      h('label', {}, ['Filters ', h('span', { className: 'optional' }, ['blank values are ignored'])]),
      filterRows,
      addFilter,
      h('label', {}, ['As of ', h('span', { className: 'optional' }, ['optional'])]),
      h('div', { className: 'asof-row' }, [asOf, asOfCell]),
      h('label', {}, ['Sort ', h('span', { className: 'optional' }, ['optional'])]),
      h('div', { className: 'asof-row' }, [sortField, sortDir]),
      h('label', { className: 'inline' }, [auto, ' Refresh when a filter cell changes']),
      h('div', { className: 'actions' }, [save, cancel]),
      formStatus,
    );
    if (editing) await loadDomain(editing.domainCode);
  };

  newButton.addEventListener('click', () => { void openForm(); });
  refreshAllButton.addEventListener('click', () => {
    void sync.refreshAll().then(({ failed }) => {
      if (failed.length) deps.setStatus(`Not refreshed: ${failed.join(', ')}. Each table shows why.`, 'error');
      else deps.setStatus('Tables refreshed.');
    });
  });
  sync.onChange(renderList);

  container.replaceChildren(
    h('h2', {}, ['Tables']),
    h('p', { className: 'help' }, [
      'Bring the records of one entity type into a table, filtered on the way in so you only get what you need. A filter can point at a cell (=B2); with auto-refresh on, changing that cell refreshes the table.',
    ]),
    list,
    h('div', { className: 'actions' }, [newButton, refreshAllButton]),
    form,
  );
  renderList();
}
