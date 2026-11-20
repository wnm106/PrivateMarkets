'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The values of the record being edited, so one field can depend on another:
 * a list field narrows its choices to the children of its controlling field's value,
 * and picking a child can fill in the fields above it.
 */
export interface RecordValues {
  /** Current value of each field on the record, by attribute code. Blank when unknown. */
  values: Record<string, string>;
  /** Saves several fields in one change. Absent where the screen cannot do that. */
  saveMany?: (changes: Record<string, string>) => Promise<void> | void;
  /** Reads the record's values again after a change made outside the fields, such as a deleted version. */
  reload?: () => Promise<void> | void;
}

const RecordValuesContext = createContext<RecordValues | null>(null);

export function RecordValuesProvider({ values, saveMany, reload, children }: RecordValues & { children: ReactNode }) {
  return <RecordValuesContext.Provider value={{ values, saveMany, reload }}>{children}</RecordValuesContext.Provider>;
}

export function useRecordValues(): RecordValues | null {
  return useContext(RecordValuesContext);
}
