'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useAttributeInspect } from './AttributeInspect';
import { isHiddenAttribute, RESTRICTED_TEXT, useHiddenAttributes } from '@/lib/hidden-attributes';

/** Where a displayed value lives in the entity model: one attribute on one entity. */
export interface AttrBind {
  entityId: string;
  entityName?: string;
  domainCode: string;
  code: string;
  name: string;
}

export function attrBind(entityId: string | null | undefined, domainCode: string, code: string, name: string, entityName?: string | null): AttrBind | null {
  if (!entityId) return null;
  return { entityId, entityName: entityName || undefined, domainCode, code, name };
}

/** Right-click handler that opens the source panel in the assistant. */
export function useInspectBind(onChanged?: () => void) {
  const inspect = useAttributeInspect();
  return (event: MouseEvent, bind: AttrBind | null, value?: string) => {
    if (!bind) return;
    event.preventDefault();
    event.stopPropagation();
    inspect.open({
      entityId: bind.entityId,
      entityName: bind.entityName,
      attributeCode: bind.code,
      attributeName: bind.name,
      domainCode: bind.domainCode,
      value,
      onChanged,
    });
  };
}

/** A read-only value that points back to its attribute. Right-click opens its sources. Unbound values render as they are. */
export function InspectValue({
  bind, value, onChanged, children,
}: {
  bind: AttrBind | null;
  value?: string | number | null;
  onChanged?: () => void;
  children: ReactNode;
}) {
  const open = useInspectBind(onChanged);
  const hidden = useHiddenAttributes();
  if (!bind) return <>{children}</>;
  // Not cleared for this field: say so, rather than show a blank that reads as missing data.
  if (isHiddenAttribute(hidden, bind.code) && (value == null || value === '')) {
    return <span className="restricted-value" title="You are not cleared to see this field">{RESTRICTED_TEXT}</span>;
  }
  return (
    <span
      className="attr-inspectable"
      title="Right-click to view sources"
      onContextMenu={(event) => open(event, bind, value == null ? undefined : String(value))}
    >
      {children}
    </span>
  );
}
