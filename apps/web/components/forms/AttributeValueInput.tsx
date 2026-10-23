'use client';

import { useEffect, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { ATTRIBUTE_REGISTER_QUERY, REFERENCE_LIST_DETAIL_QUERY, graphqlQuery } from '@/lib/graphql';
import { attributeDisplayKind, inputStepFor, inputTypeFor, inputValueFor, type AttributeDisplay } from '@/lib/attribute-display';

export interface ListOption {
  value: string;
  label: string;
  displayLabel: string;
}

interface AttributeMeta extends AttributeDisplay {
  listCode: string | null;
  listValues: string[];
}

interface Catalog {
  byAttribute: Map<string, AttributeMeta>;
  byList: Map<string, ListOption[]>;
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
    });
    if (listCode) listCodes.add(listCode);
  }

  const lists = await Promise.all([...listCodes].map(async (listCode) => {
    const result = await graphqlQuery<{
      referenceList: { values: Array<{ valueCode: string; valueLabel: string; isActive: boolean; displayOrder: number }> } | null;
    }>(REFERENCE_LIST_DETAIL_QUERY, { listCode }, 'network-only');
    const options = (result.data?.referenceList?.values || [])
      .filter((item) => item.isActive)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.valueLabel.localeCompare(b.valueLabel))
      .map((item) => ({
        value: item.valueCode,
        displayLabel: item.valueLabel || item.valueCode,
        label: item.valueLabel && item.valueLabel !== item.valueCode ? `${item.valueLabel} (${item.valueCode})` : item.valueCode,
      }));
    return [listCode, options] as const;
  }));

  return { byAttribute, byList: new Map(lists) };
}

function optionsFor(catalog: Catalog, attributeCode: string): ListOption[] {
  const meta = catalog.byAttribute.get(attributeCode);
  if (meta?.listCode) {
    const listed = catalog.byList.get(meta.listCode) || [];
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
  const options = useAttributeListOptions(attributeCode);
  const display = useAttributeDisplay(attributeCode);
  const listed = options || [];
  // A typed number is not a list. Only attributes with real choices become a dropdown.
  // Otherwise the first digit becomes the only option and further typing stops.
  const known = listed.some((option) => option.value === value);
  const choices = value && !known ? [{ value, label: value }, ...listed] : listed;

  if (listed.length > 0) {
    return (
      <select
        className={className ? `select ${className}` : 'select'}
        value={value}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        style={style}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onChange={(event) => {
          onChange(event.target.value);
          onSelect?.(event.target.value);
        }}
      >
        <option value="">{placeholder || 'Select...'}</option>
        {choices.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  const kind = attributeDisplayKind({
    dataType: dataType || display?.dataType,
    displayFormat: display?.displayFormat,
  });
  const inputType = inputTypeFor(kind);
  return (
    <input
      className={className || 'text-input'}
      type={inputType}
      step={inputStepFor(kind)}
      value={inputValueFor(kind, value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      disabled={disabled}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
