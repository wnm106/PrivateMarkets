'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AttributeExpandPanel, type ExpandableAttribute } from '@/components/admin/AttributeExpandPanel';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';
import {
  ATTRIBUTE_GRID_COLUMNS,
  ATTRIBUTE_GRID_MAX_ROWS,
  clampAttributeSpan,
  groupForDisplay,
  sectionKey,
  type AttributeSectionOrder,
} from '@/lib/attribute-layout';
import {
  ATTRIBUTE_SECTIONS_QUERY,
  graphqlClient,
  REORDER_SECTION_ATTRIBUTES_MUTATION,
  UPDATE_ATTRIBUTE_MUTATION,
} from '@/lib/graphql';

type AttributeRow = ExpandableAttribute & {
  domainCode?: string | null;
  displaySpanColumns?: number | null;
  displaySpanRows?: number | null;
};

interface SectionRow extends AttributeSectionOrder {
  id: string;
}

type AttributeGridRow = AttributeRow & { __kind: 'attribute'; __id: string; __open: boolean; __sequence: number };
type DetailGridRow = { __kind: 'detail'; __id: string; attributeId: string };
type GridRow = AttributeGridRow | DetailGridRow;

function asAttribute(row?: GridRow | null): AttributeGridRow | null {
  return row && row.__kind === 'attribute' ? row : null;
}

interface Actions {
  attributes: AttributeRow[];
  sections: SectionRow[];
  referenceLists: Array<{ listCode: string; listName: string }>;
  toggle: (id: string) => void;
  remove: (attribute: AttributeRow) => void;
  move: (attribute: AttributeRow, direction: -1 | 1) => void;
  assignSection: (attribute: AttributeRow, sectionName: string) => void;
  resize: (attribute: AttributeRow, columns: number, rows: number) => void;
  saved: () => void;
  close: () => void;
}

function sectionOf(attribute: AttributeRow) {
  return attribute.displaySection?.trim() || 'General';
}

function mutationError(result: { data?: any; error?: { message?: string } }, key: string) {
  const payload = result.data?.[key];
  return payload?.errors?.[0]?.message || result.error?.message || (payload && payload.success === false ? 'The change was not saved.' : '');
}

export function EntityAttributeGrid({
  domainCode,
  attributes,
  referenceLists,
  expandedId,
  onExpandedId,
  onDelete,
  onRefresh,
  onPatch,
}: {
  domainCode: string;
  attributes: AttributeRow[];
  referenceLists: Array<{ listCode: string; listName: string }>;
  expandedId: string | null;
  onExpandedId: (id: string | null) => void;
  onDelete: (attribute: AttributeRow) => void;
  onRefresh: () => void;
  onPatch: (id: string, patch: Partial<AttributeRow>) => void;
}) {
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [message, setMessage] = useState('');
  const actions = useRef<Actions>(null as unknown as Actions);

  const loadSections = useCallback(async () => {
    const result = await graphqlClient.query(ATTRIBUTE_SECTIONS_QUERY, { domainCode }, { requestPolicy: 'network-only' }).toPromise();
    if (result.error) {
      setMessage(result.error.message);
      return;
    }
    const rows = (result.data?.attributeSections || []) as SectionRow[];
    setSections(rows);
    setDrafts(Object.fromEntries(rows.map((section) => [section.id, section.sectionName])));
  }, [domainCode]);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const report = (error: string) => {
    setMessage(error);
    if (error) onRefresh();
  };

  const saveAttribute = useCallback(async (id: string, patch: Partial<AttributeRow>) => {
    onPatch(id, patch);
    setMessage('');
    const result = await graphqlClient.mutation(UPDATE_ATTRIBUTE_MUTATION, {
      input: {
        id,
        ...(patch.displaySection !== undefined ? { displaySection: patch.displaySection } : {}),
        ...(patch.displayGroup !== undefined ? { displayGroup: patch.displayGroup } : {}),
        ...(patch.displaySpanColumns !== undefined ? { displaySpanColumns: patch.displaySpanColumns } : {}),
        ...(patch.displaySpanRows !== undefined ? { displaySpanRows: patch.displaySpanRows } : {}),
      },
    }).toPromise();
    const error = mutationError(result, 'updateAttributeDefinition');
    if (error) report(error);
    else if (patch.displaySection) void loadSections();
  }, [loadSections, onPatch, onRefresh]);

  const moveAttribute = useCallback(async (attribute: AttributeRow, direction: -1 | 1) => {
    const section = sectionOf(attribute);
    const ordered = attributes
      .filter((item) => sectionKey(sectionOf(item)) === sectionKey(section) && (!item.domainCode || item.domainCode === domainCode))
      .sort((a, b) => (a.displayGroup || 0) - (b.displayGroup || 0) || a.attributeName.localeCompare(b.attributeName));
    const index = ordered.findIndex((item) => item.id === attribute.id);
    const target = index + direction;
    if (index < 0) {
      setMessage('This attribute is shared, so its order is not changed from this entity type.');
      return;
    }
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    next.forEach((item, position) => onPatch(item.id, { displayGroup: (position + 1) * 10, displaySection: section }));
    setMessage('');
    const result = await graphqlClient.mutation(REORDER_SECTION_ATTRIBUTES_MUTATION, {
      domainCode,
      sectionName: section,
      attributeIds: next.map((item) => item.id),
    }).toPromise();
    const error = mutationError(result, 'reorderSectionAttributes');
    if (error) report(error);
  }, [attributes, domainCode, onPatch, onRefresh]);

  const assignSection = useCallback(async (attribute: AttributeRow, sectionName: string) => {
    const peers = attributes.filter((item) => sectionKey(sectionOf(item)) === sectionKey(sectionName) && item.id !== attribute.id);
    const displayGroup = peers.reduce((max, item) => Math.max(max, item.displayGroup || 0), 0) + 10;
    await saveAttribute(attribute.id, { displaySection: sectionName, displayGroup });
  }, [attributes, saveAttribute]);

  actions.current = {
    attributes,
    sections,
    referenceLists,
    toggle: (id) => onExpandedId(expandedId === id ? null : id),
    remove: onDelete,
    move: (attribute, direction) => { void moveAttribute(attribute, direction); },
    assignSection: (attribute, sectionName) => { void assignSection(attribute, sectionName); },
    resize: (attribute, columns, rows) => { void saveAttribute(attribute.id, { displaySpanColumns: columns, displaySpanRows: rows }); },
    saved: () => { onRefresh(); void loadSections(); },
    close: () => onExpandedId(null),
  };
  const context = useMemo(() => ({ get: () => actions.current }), []);

  const rows = useMemo<GridRow[]>(() => {
    const owned = attributes.map((attribute) => ({
      ...attribute,
      section: sectionOf(attribute),
      sortOrder: attribute.displayGroup || 0,
      name: attribute.attributeName,
    }));
    return groupForDisplay(owned, sections).flatMap((group) => (
      group.items.flatMap((attribute, index) => {
        const row: AttributeGridRow = {
          ...attribute,
          __kind: 'attribute',
          __id: attribute.id,
          __open: attribute.id === expandedId,
          __sequence: index + 1,
        };
        if (attribute.id !== expandedId) return [row];
        const detail: DetailGridRow = { __kind: 'detail', __id: `${attribute.id}:detail`, attributeId: attribute.id };
        return [row, detail];
      })
    ));
  }, [attributes, expandedId, sections]);

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {message && (
        <div style={{ padding: '10px 12px', background: '#fdecec', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '13px' }}>
          {message}
        </div>
      )}

      <AppGrid
        className="attribute-grid"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.__id}
        autoHeight
        enableSortFilter={false}
        rowGroupPanelShow="never"
        emptyMessage="No attributes defined for this entity type yet."
        context={context}
        layoutKey={expandedId || 'closed'}
        isFullWidthRow={(params) => params.rowNode.data?.__kind === 'detail'}
        fullWidthCellRenderer={AttributeDetailRow}
        embedFullWidthRows={false}
        getRowHeight={(params) => (params.data?.__kind === 'detail' ? 360 : 48)}
        getRowClass={(params) => (asAttribute(params.data)?.__open ? 'attribute-row-open' : '')}
        onRowClicked={(row) => {
          const attribute = asAttribute(row);
          if (!attribute) return;
          onExpandedId(attribute.id === expandedId ? null : attribute.id);
        }}
      />
    </div>
  );
}

function AttributeDetailRow(props: {
  data?: DetailGridRow;
  node?: { rowHeight: number; setRowHeight: (height: number) => void };
  api?: { onRowHeightChanged: () => void };
  context?: { get: () => Actions };
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const actions = props.context?.get();
  const attribute = actions?.attributes.find((item) => item.id === props.data?.attributeId);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const node = props.node;
    const api = props.api;
    if (!content || !node || !api) return;
    const apply = () => {
      const height = Math.ceil(content.offsetHeight);
      if (height > 0 && Math.abs((node.rowHeight || 0) - height) > 2) {
        node.setRowHeight(height);
        api.onRowHeightChanged();
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(content);
    return () => observer.disconnect();
  }, [props.api, props.node, attribute]);

  if (!actions || !attribute) return null;
  return (
    <div ref={contentRef} className="attribute-editor">
      <AttributeExpandPanel
        attribute={attribute}
        weightAttributes={actions.attributes}
        referenceLists={actions.referenceLists}
        sectionNames={actions.sections.map((section) => section.sectionName)}
        onSaved={actions.saved}
        onCancel={actions.close}
      />
    </div>
  );
}

function ExpandCell(props: { data?: GridRow; context?: { get: () => Actions } }) {
  const row = asAttribute(props.data);
  if (!row) return null;
  return (
    <button type="button" className="btn" style={{ padding: '2px 8px' }} onClick={() => props.context?.get().toggle(row.id)} aria-label={row.__open ? 'Collapse attribute' : 'Expand attribute'}>
      {row.__open ? '▾' : '▸'}
    </button>
  );
}

function SectionCell(props: { data?: GridRow; context?: { get: () => Actions } }) {
  const row = asAttribute(props.data);
  if (!row) return null;
  const names = props.context?.get().sections.map((section) => section.sectionName) || [];
  const current = sectionOf(row);
  const options = names.some((name) => sectionKey(name) === sectionKey(current)) ? names : [current, ...names];
  return (
    <select
      className="text-input"
      value={options.find((name) => sectionKey(name) === sectionKey(current)) || current}
      aria-label={`Section for ${row.attributeCode}`}
      onMouseDown={(event) => event.stopPropagation()}
      onChange={(event) => props.context?.get().assignSection(row, event.target.value)}
      style={{ width: '100%', padding: '4px 6px' }}
    >
      {options.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  );
}

function SequenceCell(props: { data?: GridRow; context?: { get: () => Actions } }) {
  const row = asAttribute(props.data);
  if (!row) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <button type="button" className="btn" style={{ padding: '0 6px' }} onClick={() => props.context?.get().move(row, -1)} aria-label={`Move ${row.attributeCode} up`}>↑</button>
      <span className="mono" style={{ minWidth: '18px', textAlign: 'center' }}>{row.__sequence}</span>
      <button type="button" className="btn" style={{ padding: '0 6px' }} onClick={() => props.context?.get().move(row, 1)} aria-label={`Move ${row.attributeCode} down`}>↓</button>
    </span>
  );
}

function SizeCell(props: { data?: GridRow; context?: { get: () => Actions } }) {
  const row = asAttribute(props.data);
  if (!row) return null;
  const span = clampAttributeSpan(row.displaySpanColumns, row.displaySpanRows);
  const change = (columns: number, rows: number) => props.context?.get().resize(row, columns, rows);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} onMouseDown={(event) => event.stopPropagation()}>
      <select className="text-input" aria-label={`Width for ${row.attributeCode}`} value={span.columns} onChange={(event) => change(Number(event.target.value), span.rows)} style={{ width: '52px', padding: '4px' }}>
        {spanChoices(ATTRIBUTE_GRID_COLUMNS)}
      </select>
      <span style={{ color: 'var(--ink-3)' }}>×</span>
      <select className="text-input" aria-label={`Height for ${row.attributeCode}`} value={span.rows} onChange={(event) => change(span.columns, Number(event.target.value))} style={{ width: '52px', padding: '4px' }}>
        {spanChoices(ATTRIBUTE_GRID_MAX_ROWS)}
      </select>
    </span>
  );
}

function spanChoices(max: number) {
  return Array.from({ length: max }, (_, index) => {
    const value = index + 1;
    return <option key={value} value={value}>{value}</option>;
  });
}

function DeleteCell(props: { data?: GridRow; context?: { get: () => Actions } }) {
  const row = asAttribute(props.data);
  if (!row) return null;
  return (
    <button type="button" className="btn" style={{ color: 'var(--red)', padding: '2px 8px' }} onClick={() => props.context?.get().remove(row)}>
      Delete
    </button>
  );
}

const columns: ColDef<GridRow>[] = [
  { colId: 'expand', headerName: '', width: 58, minWidth: 58, maxWidth: 58, sortable: false, filter: false, enableRowGroup: false, cellRenderer: ExpandCell },
  { colId: 'name', headerName: 'Attribute', flex: 1.3, minWidth: 160, valueGetter: (params) => asAttribute(params.data)?.attributeName || '' },
  { colId: 'code', headerName: 'Code', flex: 1, minWidth: 140, valueGetter: (params) => asAttribute(params.data)?.attributeCode || '' },
  { colId: 'type', headerName: 'Type', width: 130, minWidth: 110, valueGetter: (params) => asAttribute(params.data)?.dataType || '' },
  { colId: 'section', headerName: 'Section', width: 180, minWidth: 160, sortable: false, filter: false, enableRowGroup: false, cellRenderer: SectionCell },
  { colId: 'sequence', headerName: 'Order', width: 118, minWidth: 118, maxWidth: 130, sortable: false, filter: false, enableRowGroup: false, cellRenderer: SequenceCell },
  { colId: 'size', headerName: 'Size', width: 140, minWidth: 140, sortable: false, filter: false, enableRowGroup: false, cellRenderer: SizeCell },
  { colId: 'required', headerName: 'Required', width: 110, valueGetter: (params) => asAttribute(params.data)?.isRequired ? 'Yes' : '' },
  { colId: 'multi', headerName: 'Multi', width: 90, valueGetter: (params) => asAttribute(params.data)?.isMultiValued ? 'Yes' : '' },
  { colId: 'list', headerName: 'List', width: 140, valueGetter: (params) => asAttribute(params.data)?.referenceListCode || '' },
  { colId: 'calculated', headerName: 'Calculated', width: 120, valueGetter: (params) => asAttribute(params.data)?.isDerived ? 'Yes' : '' },
  {
    colId: 'sources',
    headerName: 'Source sequence',
    flex: 1.2,
    minWidth: 180,
    valueGetter: (params) => {
      const row = asAttribute(params.data);
      if (!row) return '';
      const sequence = (row.defaultPrecedenceChain || []).filter((code) => code && code !== 'MANUAL');
      return sequence.length ? `Manual → ${sequence.join(' → ')}` : 'Manual';
    },
  },
  { colId: 'delete', headerName: '', width: 90, minWidth: 90, maxWidth: 90, sortable: false, filter: false, enableRowGroup: false, cellRenderer: DeleteCell },
];
