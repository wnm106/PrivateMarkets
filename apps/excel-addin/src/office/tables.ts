import { formatAddress, splitAddress } from '../lib/overrides';
import { columnFormats, planBody, planColumns, referenceKey, safeText, TABLE_SETTINGS_KEY, type TableColumn, type TableDefinition } from '../lib/tables';

/** Workbook side of synced tables: where definitions are kept, and writing the table in place. */

/** Rows written per round trip. Excel on the web caps the size of one request. */
const CHUNK_ROWS = 1000;

// ---------------------------------------------------------------- definitions in the workbook

export function loadDefinitions(): TableDefinition[] {
  try {
    const stored = Office.context.document.settings.get(TABLE_SETTINGS_KEY);
    return Array.isArray(stored) ? (stored as TableDefinition[]) : [];
  } catch {
    return [];
  }
}

export function saveDefinitions(definitions: TableDefinition[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      Office.context.document.settings.set(TABLE_SETTINGS_KEY, definitions);
      Office.context.document.settings.saveAsync((result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) resolve();
        else reject(new Error(result.error?.message || 'The table settings could not be saved.'));
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------- reading the workbook

export async function tableNames(): Promise<string[]> {
  return Excel.run(async (context) => {
    const tables = context.workbook.tables;
    tables.load('items/name');
    await context.sync();
    return tables.items.map((table) => table.name);
  });
}

/** The selected range as a sheet-qualified address, for "use selected cell". */
export async function selectedAddress(): Promise<{ sheet: string; address: string }> {
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load('address');
    await context.sync();
    const { sheet, address } = splitAddress(range.address);
    return { sheet, address };
  });
}

/** The sheet the table sits on, so unqualified references resolve against it. */
export async function tableSheet(tableName: string): Promise<string | null> {
  return Excel.run(async (context) => {
    const table = context.workbook.tables.getItemOrNullObject(tableName);
    table.load('name');
    const sheet = table.worksheet;
    sheet.load('name');
    await context.sync();
    return table.isNullObject ? null : sheet.name;
  });
}

/** The values of each reference, keyed by referenceKey. */
export async function readReferences(references: readonly string[]): Promise<Map<string, unknown[][]>> {
  const values = new Map<string, unknown[][]>();
  if (!references.length) return values;
  return Excel.run(async (context) => {
    const reads = references.map((reference) => {
      const { sheet, address } = splitAddress(reference);
      const worksheet = sheet ? context.workbook.worksheets.getItemOrNullObject(sheet) : context.workbook.worksheets.getActiveWorksheet();
      const range = worksheet.getRange(address);
      range.load('values');
      return { reference, range };
    });
    await context.sync();
    for (const read of reads) values.set(referenceKey(read.reference), read.range.values as unknown[][]);
    return values;
  });
}

// ---------------------------------------------------------------- writing the table

async function fillRows(
  context: Excel.RequestContext,
  table: Excel.Table,
  startRow: number,
  cells: unknown[][],
  formats: Array<string | null>,
  onProgress?: (written: number) => void,
): Promise<void> {
  for (let index = 0; index < cells.length; index += CHUNK_ROWS) {
    const chunk = cells.slice(index, index + CHUNK_ROWS);
    const band = table.getDataBodyRange().getRow(startRow + index).getResizedRange(chunk.length - 1, 0);
    // Formats first, so text such as "00123" stays text and dates show as dates.
    formats.forEach((format, column) => {
      if (format) band.getColumn(column).numberFormat = chunk.map(() => [format]);
    });
    band.values = chunk as any[][];
    await context.sync();
    onProgress?.(Math.min(index + chunk.length, cells.length));
  }
}

const isUsed = (formulas: unknown[][]) => formulas.some((row) => row.some((value) => value !== '' && value !== null));

const noRoom = (rows: number, columns: number, address: string) =>
  new Error(`The table needs ${rows + 1} rows by ${columns} columns starting at ${address}, and that area is not empty. Select an empty cell with room below and to the right.`);

/**
 * A new table at `anchor` needs an empty area for its header and `rows` rows. Checked once
 * the first page says how many rows match, so a full area fails before every page is read.
 */
export async function ensureRoom(tableName: string, anchor: { sheet: string; address: string }, rows: number, columns: number): Promise<void> {
  const needed = Math.max(rows, 1);
  return Excel.run(async (context) => {
    const table = context.workbook.tables.getItemOrNullObject(tableName);
    table.load('name');
    await context.sync();
    if (!table.isNullObject) return;
    const area = context.workbook.worksheets.getItem(anchor.sheet).getRange(anchor.address).getCell(0, 0).getResizedRange(needed, columns - 1);
    area.load('formulas');
    await context.sync();
    if (isUsed(area.formulas as unknown[][])) throw noRoom(needed, columns, anchor.address);
  });
}

export interface WriteResult {
  address: string;
  rows: number;
}

/**
 * Write the table. A new one goes at `anchor`, which must be the top-left of an
 * empty area big enough for it. An existing one is changed in place: the rows it
 * already has are overwritten, extra rows deleted, missing rows appended, so the
 * cells around it stay where they are.
 */
export async function writeTable(
  definition: TableDefinition,
  header: string[],
  cells: unknown[][],
  formats: Array<string | null>,
  anchor?: { sheet: string; address: string },
  onProgress?: (written: number) => void,
): Promise<WriteResult> {
  const labels = header.map(safeText);
  return Excel.run(async (context) => {
    let table = context.workbook.tables.getItemOrNullObject(definition.tableName);
    table.load('name');
    await context.sync();

    if (table.isNullObject) {
      if (!anchor) throw new Error('The table is no longer in this workbook. Insert it again, or stop syncing it.');
      const sheet = context.workbook.worksheets.getItem(anchor.sheet);
      const corner = sheet.getRange(anchor.address).getCell(0, 0);
      const rows = Math.max(cells.length, 1);
      const area = corner.getResizedRange(rows, labels.length - 1);
      area.load(['formulas', 'address']);
      await context.sync();
      if (isUsed(area.formulas as unknown[][])) throw noRoom(rows, labels.length, anchor.address);
      corner.getResizedRange(0, labels.length - 1).values = [labels];
      table = sheet.tables.add(area, true);
      table.name = definition.tableName;
      table.style = 'TableStyleMedium2';
      await context.sync();
      await fillRows(context, table, 0, cells, formats, onProgress);
    } else {
      const headerRow = table.getHeaderRowRange();
      headerRow.load('columnCount');
      const body = table.getDataBodyRange();
      body.load('rowCount');
      await context.sync();
      if (headerRow.columnCount !== labels.length) {
        throw new Error(`The table has ${headerRow.columnCount} columns and Tapestry writes ${labels.length}. Put your own columns next to the table, not inside it, or edit the table's columns in the pane.`);
      }
      headerRow.values = [labels];
      // Rows already there keep their formats, so a format someone chose survives a refresh.
      // New rows take the first row's format, column by column; Tapestry's only where it has none.
      const firstRow = table.getDataBodyRange().getRow(0);
      firstRow.load('numberFormat');
      await context.sync();
      const template = formats.map((format, column) => {
        const own = (firstRow.numberFormat as string[][])[0]?.[column];
        return own && own !== 'General' ? own : format;
      });
      const plan = planBody(body.rowCount, cells.length);
      await fillRows(context, table, 0, cells.slice(0, plan.overwrite), formats.map(() => null), onProgress);
      if (plan.deleteCount > 0) {
        table.getDataBodyRange().getRow(plan.deleteFrom).getResizedRange(plan.deleteCount - 1, 0).delete(Excel.DeleteShiftDirection.up);
        await context.sync();
      }
      if (plan.blankFirst) {
        table.getDataBodyRange().getRow(0).clear(Excel.ClearApplyTo.contents);
        await context.sync();
      }
      if (plan.append > 0) {
        const extra = cells.slice(plan.overwrite);
        for (let index = 0; index < extra.length; index += CHUNK_ROWS) {
          // Add blank rows, then format and fill them, so values are never typed into unformatted cells.
          const chunk = extra.slice(index, index + CHUNK_ROWS);
          table.rows.add(undefined, chunk.map((row) => row.map(() => '')) as any[][]);
          await context.sync();
        }
        await fillRows(context, table, plan.overwrite, extra, template, (written) => onProgress?.(plan.overwrite + written));
      }
    }

    const range = table.getRange();
    range.load('address');
    await context.sync();
    return { address: range.address, rows: cells.length };
  });
}

/**
 * Change a table's columns where it stands (planColumns): formulas that refer to the
 * columns that stay keep working. A new column is formatted for its kind. False when the
 * change is not that shape, or the table is not as Tapestry left it; the caller rebuilds.
 */
export async function reshapeColumns(tableName: string, before: readonly string[], after: readonly TableColumn[]): Promise<boolean> {
  const plan = planColumns(before, after.map((column) => column.code));
  if (!plan) return false;
  return Excel.run(async (context) => {
    const table = context.workbook.tables.getItemOrNullObject(tableName);
    table.load('name');
    await context.sync();
    if (table.isNullObject) return false;
    const header = table.getHeaderRowRange();
    header.load('columnCount');
    const body = table.getDataBodyRange();
    body.load('rowCount');
    await context.sync();
    if (header.columnCount !== before.length) return false;

    for (const index of plan.remove) table.columns.getItemAt(index).delete();
    const formats = columnFormats(after);
    const added = plan.add.map((code) => {
      const index = after.findIndex((column) => column.code === code);
      return { column: table.columns.add(undefined, undefined, safeText(after[index].label)), format: formats[index] };
    });
    await context.sync();
    for (const { column, format } of added) {
      if (format) column.getDataBodyRange().numberFormat = Array.from({ length: body.rowCount }, () => [format]);
    }
    await context.sync();
    return true;
  });
}

/** Remove a table and its cells, to insert it again with other columns in the same place. */
export async function removeTable(tableName: string): Promise<{ sheet: string; address: string } | null> {
  return Excel.run(async (context) => {
    const table = context.workbook.tables.getItemOrNullObject(tableName);
    table.load('name');
    await context.sync();
    if (table.isNullObject) return null;
    const range = table.getRange();
    range.load('address');
    await context.sync();
    const { sheet, address } = splitAddress(range.address);
    const corner = address.split(':')[0];
    const whole = context.workbook.worksheets.getItem(sheet).getRange(address);
    table.delete();
    whole.clear(Excel.ClearApplyTo.all);
    await context.sync();
    return { sheet, address: corner };
  });
}

/** "=B2" becomes "=Sheet!B2", so a reference keeps meaning the same cell wherever it is read. */
export function qualify(value: string, sheet: string): string {
  const text = value.trim();
  if (!text.startsWith('=')) return value;
  const { sheet: own, address } = splitAddress(text.slice(1));
  return own ? text : `=${formatAddress(sheet, address)}`;
}
