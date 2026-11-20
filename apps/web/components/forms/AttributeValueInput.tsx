'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { ATTRIBUTE_REGISTER_QUERY, REFERENCE_LIST_DETAIL_QUERY, graphqlQuery } from '@/lib/graphql';
import { attributeDisplayKind, editorFieldValue, editorInputMode, editorInputType, referenceTarget, type AttributeDisplay } from '@/lib/attribute-display';
import { EntityReferencePicker } from '@/components/forms/EntityReferencePicker';
import { useRecordValues } from '@/components/forms/RecordValues';
import { fillAncestors, optionsAtLevel, optionsUnder, outsideParent, type TreeField, type TreeOption } from '@/lib/list-tree';

export interface ListOption extends TreeOption {
  value: string;
  label: string;
  displayLabel: string;
}

interface AttributeMeta extends AttributeDisplay {
  listCode: string | null;
  listValues: string[];
  listLevel: number | null;
  controllingCode: string | null;
}

interface Catalog {
  byAttribute: Map<string, AttributeMeta>;
  byList: Map<string, ListOption[]>;
  /** Every value of each list by code, for walking a tree list. */
  byListValue: Map<string, Map<string, ListOption>>;
}

let catalogPromise: Promise<Catalog> | null = null;
let catalogCache: Catalog | null = null;

function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchCatalog().then((catalog) => {
      catalogCache = catalog;
      return catalog;
    }).catch((error) => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

function displayFrom(row: AttributeMeta | undefined): AttributeDisplay {
  if (!row) return {};
  return {
    dataType: row.dataType,
    displayFormat: row.displayFormat,
    numericPrecision: row.numericPrecision,
    unitOfMeasure: row.unitOfMeasure,
    referenceDomainCode: row.referenceDomainCode,
  };
}

export function peekAttributeDisplay(attributeCode: string | null | undefined): AttributeDisplay | null {
  if (!attributeCode) return {};
  if (!catalogCache) return null;
  return displayFrom(catalogCache.byAttribute.get(attributeCode));
}

async function fetchCatalog(): Promise<Catalog> {
  const attributes = await graphqlQuery<{
    attributeRegister: Array<{
      attributeCode: string;
      referenceListCode: string | null;
      listValues: string[] | null;
      dataType: string | null;
      displayFormat: string | null;
      numericPrecision: number | null;
      unitOfMeasure: string | null;
      referenceDomainCode: string | null;
      referenceListLevel: number | null;
      controllingAttributeCode: string | null;
    }>;
  }>(ATTRIBUTE_REGISTER_QUERY, {}, 'network-only');
  const byAttribute = new Map<string, AttributeMeta>();
  const listCodes = new Set<string>();
  for (const attribute of attributes.data?.attributeRegister || []) {
    const listCode = attribute.referenceListCode || null;
    byAttribute.set(attribute.attributeCode, {
      listCode,
      listValues: (attribute.listValues || []).map(String).filter(Boolean),
      dataType: attribute.dataType,
      displayFormat: attribute.displayFormat,
      numericPrecision: attribute.numericPrecision,
      unitOfMeasure: attribute.unitOfMeasure,
      referenceDomainCode: attribute.referenceDomainCode,
      listLevel: attribute.referenceListLevel ?? null,
      controllingCode: attribute.controllingAttributeCode || null,
    });
    if (listCode) listCodes.add(listCode);
  }

  const lists = await Promise.all([...listCodes].map(async (listCode) => {
    const result = await graphqlQuery<{
      referenceList: { values: Array<{ valueCode: string; valueLabel: string; isActive: boolean; displayOrder: number; parentValueCode?: string | null; level?: number | null }> } | null;
    }>(REFERENCE_LIST_DETAIL_QUERY, { listCode }, 'network-only').catch(() => null);
    const options = (result?.data?.referenceList?.values || [])
      .filter((item) => item.isActive)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.valueLabel.localeCompare(b.valueLabel))
      .map((item) => ({
        value: item.valueCode,
        displayLabel: item.valueLabel || item.valueCode,
        label: item.valueLabel && item.valueLabel !== item.valueCode ? `${item.valueLabel} (${item.valueCode})` : item.valueCode,
        parent: item.parentValueCode ?? null,
        level: item.level ?? null,
      }));
    return [listCode, options] as const;
  }));

  const byListValue = new Map(lists.map(([listCode, options]) => [listCode, new Map(options.map((option) => [option.value, option]))] as const));
  return { byAttribute, byList: new Map(lists), byListValue };
}

function optionsFor(catalog: Catalog, attributeCode: string): ListOption[] {
  const meta = catalog.byAttribute.get(attributeCode);
  if (meta?.listCode) {
    const listed = optionsAtLevel(catalog.byList.get(meta.listCode) || [], meta.listLevel);
    if (listed.length > 0) return listed;
  }
  return (meta?.listValues || []).map((value) => ({ value, label: value, displayLabel: value }));
}

export function peekAttributeListOptions(attributeCode: string | null | undefined): ListOption[] | null {
  if (!attributeCode) return [];
  if (!catalogCache) return null;
  return optionsFor(catalogCache, attributeCode);
}

export function listDisplayLabel(value: string, options: ListOption[] | null | undefined): string | null {
  if (!value || !options?.length) return null;
  const match = options.find((option) => option.value === value || option.displayLabel === value || option.label === value);
  return match?.displayLabel || null;
}

export function useAttributeListOptions(attributeCode: string | null | undefined) {
  const [options, setOptions] = useState<ListOption[] | null>(() => peekAttributeListOptions(attributeCode));

  useEffect(() => {
    if (!attributeCode) {
      setOptions([]);
      return;
    }
    const cached = peekAttributeListOptions(attributeCode);
    if (cached) setOptions(cached);
    let cancelled = false;
    loadCatalog().then((catalog) => {
      if (cancelled) return;
      setOptions(optionsFor(catalog, attributeCode));
    }).catch(() => {
      if (!cancelled) setOptions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [attributeCode]);

  return options;
}

export function useAttributeDisplay(attributeCode: string | null | undefined) {
  const [meta, setMeta] = useState<AttributeDisplay | null>(() => peekAttributeDisplay(attributeCode));

  useEffect(() => {
    if (!attributeCode) {
      setMeta({});
      return;
    }
    const cached = peekAttributeDisplay(attributeCode);
    if (cached) setMeta(cached);
    let cancelled = false;
    loadCatalog().then((catalog) => {
      if (cancelled) return;
      setMeta(displayFrom(catalog.byAttribute.get(attributeCode)));
    }).catch(() => {
      if (!cancelled) setMeta({});
    });
    return () => {
      cancelled = true;
    };
  }, [attributeCode]);

  return meta;
}

export interface AttributeTree {
  /** The field's list, level and controlling field. Null for fields not on a list. */
  field: TreeField | null;
  /** Every value of the field's list by code. */
  all: Map<string, ListOption>;
  fieldOf: (attributeCode: string) => TreeField | undefined;
}

const NO_TREE: AttributeTree = { field: null, all: new Map(), fieldOf: () => undefined };

function treeFrom(catalog: Catalog | null, attributeCode: string | null | undefined): AttributeTree {
  const meta = catalog && attributeCode ? catalog.byAttribute.get(attributeCode) : undefined;
  if (!catalog || !meta?.listCode) return NO_TREE;
  const fieldOf = (code: string): TreeField | undefined => {
    const row = catalog.byAttribute.get(code);
    return row ? { listCode: row.listCode, listLevel: row.listLevel, controllingCode: row.controllingCode } : undefined;
  };
  return {
    field: { listCode: meta.listCode, listLevel: meta.listLevel, controllingCode: meta.controllingCode },
    all: catalog.byListValue.get(meta.listCode) || new Map(),
    fieldOf,
  };
}

/** Where a list field sits in its list's tree, and the field that controls it. */
export function useAttributeTree(attributeCode: string | null | undefined): AttributeTree {
  const [tree, setTree] = useState<AttributeTree>(() => treeFrom(catalogCache, attributeCode));

  useEffect(() => {
    if (!attributeCode) {
      setTree(NO_TREE);
      return;
    }
    setTree(treeFrom(catalogCache, attributeCode));
    let cancelled = false;
    loadCatalog().then((catalog) => {
      if (!cancelled) setTree(treeFrom(catalog, attributeCode));
    }).catch(() => {
      if (!cancelled) setTree(NO_TREE);
    });
    return () => {
      cancelled = true;
    };
  }, [attributeCode]);

  return tree;
}

/**
 * The controlling field's value, and whether this field's value sits outside it.
 * For a list field with no controlling field, or off a record, both are empty.
 */
export function useParentConflict(attributeCode: string | null | undefined, value: string | null | undefined) {
  const tree = useAttributeTree(attributeCode);
  const record = useRecordValues();
  const controlling = tree.field?.controllingCode || null;
  const parentValue = controlling ? record?.values[controlling] || '' : '';
  const parentLabel = parentValue ? tree.all.get(parentValue)?.displayLabel || parentValue : '';
  const conflict = Boolean(controlling) && outsideParent(value, parentValue, tree.all);
  return { conflict, parentLabel, controllingCode: controlling };
}

export function AttributeValueInput({
  attributeCode,
  value,
  onChange,
  onSelect,
  dataType,
  className,
  placeholder,
  ariaLabel,
  autoFocus,
  disabled,
  style,
  onKeyDown,
  onBlur,
  onClick,
}: {
  attributeCode?: string | null;
  value: string;
  onChange: (value: string) => void;
  onSelect?: (value: string) => void;
  dataType?: string | null;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onBlur?: () => void;
  onClick?: (event: MouseEvent) => void;
}) {
  const levelOptions = useAttributeListOptions(attributeCode);
  const display = useAttributeDisplay(attributeCode);
  const tree = useAttributeTree(attributeCode);
  const record = useRecordValues();
  const controlling = tree.field?.controllingCode || null;
  const parentValue = controlling ? record?.values[controlling] || '' : '';
  // On a record, a field under a controlling field offers only children of its value.
  const options = levelOptions && controlling ? optionsUnder(levelOptions, parentValue, tree.all) : levelOptions;
  const pick = (next: string) => {
    onChange(next);
    onSelect?.(next);
    if (!next || !controlling || !record?.saveMany) return;
    // Picking a lower level fills in the levels above it.
    const { [attributeCode || '']: _own, ...above } = fillAncestors(attributeCode || '', next, tree.fieldOf, tree.all, record.values);
    if (Object.keys(above).length > 0) void record.saveMany(above);
  };
  const [focused, setFocused] = useState(Boolean(autoFocus));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const revealStart = useRef(Boolean(autoFocus));
  const openedList = useRef(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !revealStart.current) return;
    revealStart.current = false;
    input.scrollLeft = 0;
  });
  useLayoutEffect(() => {
    const select = selectRef.current;
    if (!autoFocus || !select || openedList.current) return;
    openedList.current = true;
    try {
      select.showPicker();
    } catch {
      // The click that opened the field has already ended. The list stays closed.
    }
  });
  const waitingForList = Boolean(attributeCode) && options === null;
  const listed = options || [];
  // A typed number is not a list. Only attributes with real choices become a dropdown.
  // Otherwise the first digit becomes the only option and further typing stops.
  const known = listed.some((option) => option.value === value);
  // A current value outside the offered choices stays visible, so opening the field does not lose it.
  const choices = value && !known ? [{ value, label: tree.all.get(value) ? `${tree.all.get(value)!.label} (not under the field above)` : value }, ...listed] : listed;

  const target = referenceTarget({ dataType: dataType || display?.dataType, referenceDomainCode: display?.referenceDomainCode });
  if (target) {
    return (
      <EntityReferencePicker
        domainCode={target}
        value={value}
        onChange={onChange}
        onSelect={onSelect}
        className={className && className !== 'select' ? className : 'text-input'}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        style={style}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onClick={onClick}
      />
    );
  }

  if (waitingForList) {
    return (
      <select className="select" aria-label={ariaLabel} disabled value="">
        <option value="">Loading choices…</option>
      </select>
    );
  }

  if (listed.length > 0) {
    return (
      <select
        ref={selectRef}
        className={['select', ...(className || '').split(' ').filter((name) => name && name !== 'text-input' && name !== 'select')].join(' ')}
        value={value}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        style={style ? { ...style, paddingRight: '1.6rem' } : style}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onChange={(event) => pick(event.target.value)}
      >
        <option value="">{placeholder || 'Select...'}</option>
        {choices.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  const meta: AttributeDisplay = {
    dataType: dataType || display?.dataType,
    displayFormat: display?.displayFormat,
    numericPrecision: display?.numericPrecision,
    unitOfMeasure: display?.unitOfMeasure,
  };
  const kind = attributeDisplayKind(meta);
  const shown = editorFieldValue(value, meta, focused);
  const inputType = editorInputType(kind);

  return (
    <input
      ref={inputRef}
      className={className && className !== 'select' ? className : 'text-input'}
      type={inputType}
      inputMode={editorInputMode(kind)}
      value={shown}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      disabled={disabled}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        revealStart.current = true;
        setFocused(true);
        event.currentTarget.scrollLeft = 0;
      }}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
