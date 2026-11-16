'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useAttributeInspect } from './AttributeInspect';

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
  if (!bind) return <>{children}</>;
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
