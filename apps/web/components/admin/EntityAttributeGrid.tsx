'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AttributeExpandPanel, type ExpandableAttribute } from '@/components/admin/AttributeExpandPanel';
import { AppGrid, type ColDef } from '@/components/grid/AppGrid';
import {
  ATTRIBUTE_GRID_COLUMNS,
  ATTRIBUTE_GRID_MAX_ROWS,
  clampAttributeSpan,
  planAttributeMove,
  sectionKey,
  sectionsForDisplay,
  type AttributeDropTarget,
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
type SectionGridRow = { __kind: 'section'; __id: string; sectionName: string; count: number };
type GridRow = AttributeGridRow | DetailGridRow | SectionGridRow;
type DropHint = { rowId: string; edge: 'before' | 'after' | 'into' };

function asAttribute(row?: GridRow | null): AttributeGridRow | null {
  return row && row.__kind === 'attribute' ? row : null;
}

interface Actions {
  domainCode: string;
  attributes: AttributeRow[];
  sections: SectionRow[];
  referenceLists: Array<{ listCode: string; listName: string }>;
  toggle: (id: string) => void;
  remove: (attribute: AttributeRow) => void;
  assignSection: (attribute: AttributeRow, sectionName: string) => void;
  canDrag: (attribute: AttributeRow) => boolean;
  beginDrag: (id: string) => void;
  endDrag: () => void;
  resize: (attribute: AttributeRow, columns: number, rows: number) => void;
  saved: () => void;
  close: () => void;
}

function sectionOf(attribute: AttributeRow) {
  return attribute.displaySection?.trim() || 'General';
}

function sectionRowId(name: string) {
  return `section:${sectionKey(name)}`;
}

function ownedHere(attribute: AttributeRow, domainCode: string) {
  return attribute.domainCode === domainCode;
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
  const [sections, setSections] = useState<SectionRow[] | null>(null);
  const [message, setMessage] = useState('');
  const actions = useRef<Actions>(null as unknown as Actions);
  const sectionReq = useRef(0);

  const loadSections = useCallback(async () => {
    const request = ++sectionReq.current;
    const result = await graphqlClient.query(ATTRIBUTE_SECTIONS_QUERY, { domainCode }, { requestPolicy: 'network-only' }).toPromise();
    if (request !== sectionReq.current) return;
    if (result.error) {
      setMessage(result.error.message);
      setSections((current) => current ?? []);
      return;
    }
    const rows = (result.data?.attributeSections || []) as SectionRow[];
    setSections(rows);
  }, [domainCode]);

  useEffect(() => {
    setSections(null);
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

  const gridRootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string | null; hint: DropHint | null }>({ id: null, hint: null });

  const paintDrag = () => {
    const root = gridRootRef.current;
    if (!root) return;
    root.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-into, .is-dragging').forEach((row) => {
      row.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-into', 'is-dragging');
    });
    const { id, hint } = dragRef.current;
    if (id) root.querySelector(`.ag-row[row-id="${CSS.escape(id)}"]`)?.classList.add('is-dragging');
    if (!hint) return;
    const edge = hint.edge === 'before' ? 'is-drop-before' : hint.edge === 'after' ? 'is-drop-after' : 'is-drop-into';
    root.querySelector(`.ag-row[row-id="${CSS.escape(hint.rowId)}"]`)?.classList.add(edge);
  };

  const setDrag = (id: string | null, hint: DropHint | null) => {
    const current = dragRef.current;
    if (current.id === id && current.hint?.rowId === hint?.rowId && current.hint?.edge === hint?.edge) return;
    dragRef.current = { id, hint };
    paintDrag();
  };

  const placeAttribute = useCallback(async (attributeId: string, target: AttributeDropTarget) => {
    const attribute = attributes.find((item) => item.id === attributeId);
    if (!attribute || !ownedHere(attribute, domainCode)) {
      setMessage('This attribute is shared, so its order is not changed from this entity type.');
      return;
    }
    const groups = sectionsForDisplay(
      attributes.map((item) => ({
        id: item.id,
        section: sectionOf(item),
        sortOrder: item.displayGroup || 0,
        name: item.attributeName,
        owned: ownedHere(item, domainCode),
      })),
      sections ?? [],
    ).map((group) => ({
      section: group.section,
      items: group.items.map((item) => ({ id: item.id, owned: item.owned })),
    }));
    const plan = planAttributeMove(groups, attributeId, target);
    if (!plan) return;
    plan.attributeIds.forEach((id, index) => onPatch(id, { displaySection: plan.section, displayGroup: (index + 1) * 10 }));
    setMessage('');
    const result = await graphqlClient.mutation(REORDER_SECTION_ATTRIBUTES_MUTATION, {
      domainCode,
      sectionName: plan.section,
      attributeIds: plan.attributeIds,
    }).toPromise();
    const error = mutationError(result, 'reorderSectionAttributes');
    if (error) report(error);
    else void loadSections();
  }, [attributes, domainCode, loadSections, onPatch, onRefresh, sections]);

  const assignSection = useCallback(async (attribute: AttributeRow, sectionName: string) => {
    const peers = attributes.filter((item) => sectionKey(sectionOf(item)) === sectionKey(sectionName) && item.id !== attribute.id);
    const displayGroup = peers.reduce((max, item) => Math.max(max, item.displayGroup || 0), 0) + 10;
    await saveAttribute(attribute.id, { displaySection: sectionName, displayGroup });
  }, [attributes, saveAttribute]);

  actions.current = {
    attributes,
    sections: sections ?? [],
    referenceLists,
    toggle: (id) => onExpandedId(expandedId === id ? null : id),
    remove: onDelete,
    domainCode,
    assignSection: (attribute, sectionName) => { void assignSection(attribute, sectionName); },
    canDrag: (attribute) => ownedHere(attribute, domainCode),
    beginDrag: (id) => setDrag(id, null),
    endDrag: () => setDrag(null, null),
    resize: (attribute, columns, rows) => { void saveAttribute(attribute.id, { displaySpanColumns: columns, displaySpanRows: rows }); },
    saved: () => { onRefresh(); void loadSections(); },
    close: () => onExpandedId(null),
  };
  const context = useMemo(() => ({ get: () => actions.current }), []);

  const rows = useMemo<GridRow[]>(() => {
    if (!sections) return [];
    const owned = attributes.map((attribute) => ({
      ...attribute,
      section: sectionOf(attribute),
      sortOrder: attribute.displayGroup || 0,
      name: attribute.attributeName,
    }));
    return sectionsForDisplay(owned, sections).flatMap((group) => {
      const header: SectionGridRow = {
        __kind: 'section',
        __id: sectionRowId(group.section),
        sectionName: group.section,
        count: group.items.length,
      };
      const body = group.items.flatMap((attribute, index) => {
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
      });
      return [header, ...body];
    });
  }, [attributes, expandedId, sections]);

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {message && (
        <div style={{ padding: '10px 12px', background: '#fdecec', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '13px' }}>
          {message}
        </div>
      )}

      <div
        ref={gridRootRef}
        onDragOver={(event) => {
          if (!dragRef.current.id) return;
          const rowEl = (event.target as HTMLElement | null)?.closest?.('.ag-row') as HTMLElement | null;
          const rowId = rowEl?.getAttribute('row-id') || '';
          if (!rowEl || !rowId) return;
          event.preventDefault();
          const isSection = rowId.startsWith('section:');
          const isDetail = rowId.endsWith(':detail');
          const rect = rowEl.getBoundingClientRect();
          const edge: DropHint['edge'] = isSection
            ? 'into'
            : isDetail
              ? 'after'
              : (event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
          setDrag(dragRef.current.id, { rowId, edge });
        }}
        onDrop={(event) => {
          event.preventDefault();
          const dragId = dragRef.current.id;
          const hint = dragRef.current.hint;
          setDrag(null, null);
          if (!dragId || !hint) return;
          const row = rows.find((item) => item.__id === hint.rowId);
          if (!row) return;
          const target: AttributeDropTarget | null = row.__kind === 'section'
            ? { kind: 'section', section: row.sectionName }
            : row.__kind === 'detail'
              ? { kind: 'after', attributeId: row.attributeId }
              : hint.edge === 'into'
                ? null
                : { kind: hint.edge, attributeId: row.id };
          if (target) void placeAttribute(dragId, target);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDrag(dragRef.current.id, null);
        }}
      >
        <p style={{ margin: '0 0 8px', fontSize: '12px', color: 'var(--ink-3)' }}>
          Drag an attribute to change its order, or drop it on another section.
        </p>
        <AppGrid
          className="attribute-grid"
          rows={rows}
          columns={columns}
          getRowId={(row) => row.__id}
          autoHeight
          enableSortFilter={false}
          rowGroupPanelShow="never"
          loading={sections === null}
          emptyMessage={sections === null ? 'Loading…' : 'No attributes defined for this entity type yet.'}
          context={context}
          layoutKey={expandedId || 'closed'}
          isFullWidthRow={(params) => {
            const kind = params.rowNode.data?.__kind;
            return kind === 'detail' || kind === 'section';
          }}
          fullWidthCellRenderer={AttributeFullWidthRow}
          embedFullWidthRows={false}
          getRowHeight={(params) => {
            if (params.data?.__kind === 'section') return 36;
            if (params.data?.__kind === 'detail') return 360;
            return 48;
          }}
          getRowClass={(params) => {
            const classes: string[] = [];
            if (params.data?.__kind === 'section') classes.push('attribute-section-row');
            if (params.data?.__kind === 'detail') classes.push('attribute-detail-row');
            if (asAttribute(params.data)?.__open) classes.push('attribute-row-open');
            return classes.join(' ');
          }}
          onRowClicked={(row) => {
            const attribute = asAttribute(row);
            if (!attribute) return;
            onExpandedId(attribute.id === expandedId ? null : attribute.id);
          }}
        />
      </div>
    </div>
  );
}

function AttributeFullWidthRow(props: {
  data?: GridRow;
  node?: { rowHeight: number; setRowHeight: (height: number) => void };
  api?: { onRowHeightChanged: () => void };
  context?: { get: () => Actions };
}) {
  if (props.data?.__kind === 'section') {
    const count = props.data.count;
    return (
      <div className="attribute-section-banner">
        <span>{props.data.sectionName}</span>
        <span style={{ fontWeight: 500, color: 'var(--ink-3)' }}>
          {count === 0 ? 'Drop an attribute here' : `${count} attribute${count === 1 ? '' : 's'}`}
        </span>
      </div>
    );
  }
  if (props.data?.__kind !== 'detail') return null;
  return <AttributeDetailRow data={props.data} node={props.node} api={props.api} context={props.context} />;
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
    <div ref={contentRef} className="attribute-editor-wrap"><div className="attribute-editor">
      <AttributeExpandPanel
        attribute={attribute}
        domainCode={actions.domainCode}
        weightAttributes={actions.attributes}
        referenceLists={actions.referenceLists}
        sectionNames={actions.sections.map((section) => section.sectionName)}
        onSaved={actions.saved}
        onCancel={actions.close}
      />
    </div></div>
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

function OrderCell(props: { data?: GridRow; context?: { get: () => Actions } }) {
  const row = asAttribute(props.data);
  if (!row) return null;
  const actions = props.context?.get();
  const draggable = actions?.canDrag(row) ?? false;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} onMouseDown={(event) => event.stopPropagation()}>
      {draggable ? (
        <button
          type="button"
          className="section-drag"
          draggable
          aria-label={`Drag ${row.attributeCode}`}
          onDragStart={(event) => {
            actions?.beginDrag(row.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', row.id);
          }}
          onDragEnd={() => actions?.endDrag()}
        >
          ⋮⋮
        </button>
      ) : (
        <span style={{ width: '22px' }} />
      )}
      <span className="mono" style={{ minWidth: '18px', textAlign: 'center' }}>{row.__sequence}</span>
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
  { colId: 'sequence', headerName: 'Order', width: 96, minWidth: 96, maxWidth: 110, sortable: false, filter: false, enableRowGroup: false, cellRenderer: OrderCell },
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
