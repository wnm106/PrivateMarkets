// A null client id is the global row. A caller's client row replaces the
// global row with the same code. Other clients' rows are ignored.

export interface ClientScopedRow {
  code: string;
  clientId: string | null;
}

export function preferClientScope<T extends ClientScopedRow>(rows: T[], clientId: string | null): T[] {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    if (row.clientId && row.clientId !== clientId) continue;
    const current = chosen.get(row.code);
    if (!current || (clientId !== null && row.clientId === clientId)) {
      chosen.set(row.code, row);
    }
  }
  return [...chosen.values()];
}

export interface ScopedComponent {
  code: string;
  clientId: string | null;
}

export function mergeClientComponents<T extends ScopedComponent>(rows: T[], clientId: string | null): T[] {
  const visible = rows.filter((row) => row.clientId === null || row.clientId === clientId);
  const overrides = new Map<string, T>();
  for (const row of visible) {
    if (row.clientId) overrides.set(row.code, row);
  }
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const row of visible) {
    if (row.clientId) continue;
    seen.add(row.code);
    merged.push(overrides.get(row.code) ?? row);
  }
  for (const row of overrides.values()) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    merged.push(row);
  }
  return merged;
}

export function panelKeyForSlot(
  components: Array<{ slotCode: string; status: string; panelKey?: string | null }>,
): Map<string, string> {
  const panels = new Map<string, string>();
  for (const component of components) {
    if (component.status !== 'QUALIFIED' || !component.panelKey) continue;
    if (!panels.has(component.slotCode)) panels.set(component.slotCode, component.panelKey);
  }
  return panels;
}
