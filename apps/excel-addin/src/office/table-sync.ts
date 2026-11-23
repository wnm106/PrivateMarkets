import type { ExcelAuth } from '../lib/auth';
import type { GraphQLClient } from '../lib/graphql';
import { splitAddress } from '../lib/overrides';
import {
  columnFormats,
  fieldKinds,
  gridInput,
  MAX_TABLE_ROWS,
  parseRange,
  rangesIntersect,
  readAllRows,
  referencesOf,
  RefreshScheduler,
  resolveFilters,
  rowsToCells,
  TABLE_QUERY,
  tableNameFor,
  withGridKinds,
  type GridPage,
  type TableDefinition,
} from '../lib/tables';
import { ensureRoom, loadDefinitions, qualify, readReferences, removeTable, reshapeColumns, saveDefinitions, tableNames, tableSheet, writeTable } from './tables';

/**
 * Keeps the workbook's synced tables: refreshes them on request, and refreshes a table
 * with auto-refresh on when one of its filter cells changes, by an edit or by a
 * recalculation. One instance runs in the add-in's shared runtime.
 */

export interface TableStatus {
  state: 'idle' | 'working' | 'ok' | 'error';
  message: string;
}

/** How long Excel can keep recalculating, or someone typing, before the filter cells are read again. */
const CHECK_DELAY_MS = 800;
/** The check already waits for changes to stop; this only gathers checks that land together. */
const REFRESH_DELAY_MS = 200;

export class TableSync {
  private definitions: TableDefinition[] = [];
  private statuses = new Map<string, TableStatus>();
  private listeners = new Set<() => void>();
  private refreshing = new Set<string>();
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scheduler: RefreshScheduler;
  private watching = false;

  constructor(private readonly graphql: Pick<GraphQLClient, 'request'>, private readonly auth: Pick<ExcelAuth, 'email'>) {
    this.scheduler = new RefreshScheduler((name) => this.refresh(name), REFRESH_DELAY_MS);
  }

  /** Read the workbook's tables, start watching, and catch up on filters changed while the add-in was closed. */
  async start(): Promise<void> {
    this.definitions = loadDefinitions();
    this.emit();
    await this.watch();
    await this.applyStartupBehavior();
    this.scheduleCheck();
  }

  list(): TableDefinition[] {
    return [...this.definitions];
  }

  status(tableName: string): TableStatus {
    return this.statuses.get(tableName) || { state: 'idle', message: '' };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Insert a new table at the selected cell, then keep it. */
  async create(draft: Omit<TableDefinition, 'tableName'>, anchor: { sheet: string; address: string }): Promise<TableDefinition> {
    const definition: TableDefinition = {
      ...this.qualified(draft, anchor.sheet),
      tableName: tableNameFor(draft.domainCode, await tableNames()),
    };
    this.definitions.push(definition);
    try {
      await this.refresh(definition.tableName, anchor, true);
    } catch (error) {
      this.definitions = this.definitions.filter((item) => item.tableName !== definition.tableName);
      this.statuses.delete(definition.tableName);
      this.emit();
      throw error;
    }
    await this.persist();
    return definition;
  }

  /**
   * Change a table's definition and refresh it in place. Columns are changed where the table
   * stands, so formulas on the columns that stay keep working; if that is not possible the
   * table is rebuilt at the same corner.
   */
  async update(tableName: string, draft: Omit<TableDefinition, 'tableName'>): Promise<void> {
    const index = this.definitions.findIndex((item) => item.tableName === tableName);
    if (index < 0) throw new Error('That table is not synced in this workbook.');
    const previous = this.definitions[index];
    const sheet = (await tableSheet(tableName)) || '';
    const next: TableDefinition = { ...previous, ...this.qualified(draft, sheet), tableName, lastSignature: undefined };
    const sameColumns = JSON.stringify(previous.columns.map((column) => column.code)) === JSON.stringify(next.columns.map((column) => column.code));
    this.definitions[index] = next;
    if (sameColumns || (await reshapeColumns(tableName, previous.columns.map((column) => column.code), next.columns))) {
      await this.refresh(tableName, undefined, true);
    } else {
      const corner = await removeTable(tableName);
      await this.refresh(tableName, corner || undefined, true);
    }
    await this.persist();
  }

  /** Stop syncing. The table and its values stay as plain cells of a normal Excel table. */
  async stop(tableName: string): Promise<void> {
    this.definitions = this.definitions.filter((item) => item.tableName !== tableName);
    this.statuses.delete(tableName);
    await this.persist();
  }

  async setAutoRefresh(tableName: string, on: boolean): Promise<void> {
    const definition = this.definitions.find((item) => item.tableName === tableName);
    if (!definition) return;
    definition.autoRefresh = on;
    await this.persist();
    if (on) this.scheduleCheck();
  }

  /** Refresh every table. One that fails keeps its error as its status, and the rest still refresh. */
  async refreshAll(): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    for (const definition of this.list()) {
      await this.refresh(definition.tableName);
      if (this.status(definition.tableName).state === 'error') failed.push(definition.tableName);
    }
    return { failed };
  }

  /** Read the filters, query, and write the table. Errors are kept as the table's status. */
  async refresh(tableName: string, anchor?: { sheet: string; address: string }, rethrow = false): Promise<void> {
    const definition = this.definitions.find((item) => item.tableName === tableName);
    if (!definition || this.refreshing.has(tableName)) return;
    this.refreshing.add(tableName);
    const set = (state: TableStatus['state'], message: string) => { this.statuses.set(tableName, { state, message }); this.emit(); };
    try {
      if (!this.auth.email()) throw new Error('Sign in to refresh this table.');
      set('working', 'Reading filters…');
      const cells = await readReferences(referencesOf(definition));
      const { kinds, labels } = fieldKinds(definition);
      const resolved = resolveFilters(definition, cells, kinds, labels);
      if (!resolved.ok) throw new Error(resolved.message);

      set('working', 'Reading from Tapestry…');
      const result = await readAllRows(
        async (offset) => {
          const page = (await this.graphql.request<{ gridQuery: GridPage }>(TABLE_QUERY, { input: gridInput(definition, resolved, offset) })).gridQuery;
          if (offset === 0 && anchor && page.matched <= MAX_TABLE_ROWS) await ensureRoom(tableName, anchor, page.matched, definition.columns.length);
          return page;
        },
        (read, matched) => set('working', `Reading ${read.toLocaleString()} of ${matched.toLocaleString()} rows…`),
      );
      if (!result.ok) throw new Error(result.message);

      definition.columns = withGridKinds(definition.columns, result.columns);
      const values = rowsToCells(definition.columns, result.rows);
      set('working', 'Writing the table…');
      const written = await writeTable(
        definition,
        definition.columns.map((column) => column.label),
        values,
        columnFormats(definition.columns),
        anchor || definition.location,
        (count) => set('working', `Writing ${count.toLocaleString()} of ${values.length.toLocaleString()} rows…`),
      );
      const place = splitAddress(written.address);
      definition.location = { sheet: place.sheet, address: place.address.split(':')[0] };
      definition.lastSignature = resolved.signature;
      definition.lastRefreshed = new Date().toISOString();
      definition.rowCount = values.length;
      await this.persist();
      set('ok', `${values.length.toLocaleString()} row${values.length === 1 ? '' : 's'} · refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } catch (error) {
      set('error', error instanceof Error ? error.message : 'The table could not be refreshed.');
      if (rethrow) throw error;
    } finally {
      this.refreshing.delete(tableName);
      // A filter cell changed while this table was refreshing is caught here.
      if (definition.autoRefresh) this.scheduleCheck();
    }
  }

  // ---------------------------------------------------------------- auto-refresh

  /** Refresh each auto table whose filter values differ from its last refresh. */
  private async checkAuto(): Promise<void> {
    if (!this.auth.email()) return;
    for (const definition of this.definitions) {
      if (!definition.autoRefresh || this.refreshing.has(definition.tableName)) continue;
      try {
        const cells = await readReferences(referencesOf(definition));
        const { kinds, labels } = fieldKinds(definition);
        const resolved = resolveFilters(definition, cells, kinds, labels);
        if (!resolved.ok) {
          this.statuses.set(definition.tableName, { state: 'error', message: resolved.message });
          this.emit();
          continue;
        }
        if (resolved.signature !== definition.lastSignature) this.scheduler.request(definition.tableName);
      } catch {
        /* A sheet that was renamed or deleted shows up when the table is refreshed. */
      }
    }
  }

  private scheduleCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => { this.checkTimer = null; void this.checkAuto(); }, CHECK_DELAY_MS);
  }

  /** An edit to a filter cell refreshes its tables. A recalculation may change a filter cell's value, so it checks them. */
  private async watch(): Promise<void> {
    if (this.watching) return;
    try {
      await Excel.run(async (context) => {
        context.workbook.worksheets.onChanged.add(async (event) => {
          const auto = this.definitions.filter((definition) => definition.autoRefresh && referencesOf(definition).length);
          if (!auto.length) return;
          const sheetName = await Excel.run(async (inner) => {
            const sheet = inner.workbook.worksheets.getItem(event.worksheetId);
            sheet.load('name');
            await inner.sync();
            return sheet.name;
          }).catch(() => '');
          const changed = parseRange(event.address, sheetName);
          if (!changed) return;
          for (const definition of auto) {
            const touched = referencesOf(definition).some((reference) => {
              const range = parseRange(reference, splitAddress(reference).sheet);
              return range ? rangesIntersect(range, changed) : false;
            });
            if (touched) this.scheduleCheck();
          }
        });
        context.workbook.worksheets.onCalculated.add(async () => {
          if (this.definitions.some((definition) => definition.autoRefresh && referencesOf(definition).length)) this.scheduleCheck();
        });
        await context.sync();
      });
      this.watching = true;
    } catch {
      // Older Excel without these events: tables still refresh on request.
    }
  }

  /** Load the add-in with the workbook while any table refreshes on its own, so it can watch from the start. */
  private async applyStartupBehavior(): Promise<void> {
    try {
      const auto = this.definitions.some((definition) => definition.autoRefresh);
      await Office.addin?.setStartupBehavior(auto ? Office.StartupBehavior.load : Office.StartupBehavior.none);
    } catch {
      /* Hosts without the shared runtime API keep the default. */
    }
  }

  private qualified(draft: Omit<TableDefinition, 'tableName'>, sheet: string): Omit<TableDefinition, 'tableName'> {
    return {
      ...draft,
      asOf: qualify(draft.asOf, sheet),
      filters: draft.filters.map((filter) => ({ ...filter, value: qualify(filter.value, sheet) })),
    };
  }

  private async persist(): Promise<void> {
    await saveDefinitions(this.definitions);
    await this.applyStartupBehavior();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A listener must not stop a refresh. */ }
    }
  }
}
