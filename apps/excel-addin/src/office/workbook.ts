import { SHORT_NAME, SHORT_NAME_COMMENT, SHORT_NAME_FORMULA, QUALIFIED_FUNCTION } from '../lib/formula';

/** Workbook actions the pane takes. Each is one Excel.run. */

/**
 * Make =TAP(...) work in this workbook by adding the TAP name (a LAMBDA over
 * TAPESTRY.TAP). A TAP name the workbook already has for something else is left alone.
 * True when =TAP can be used.
 */
export async function ensureShortName(): Promise<boolean> {
  try {
    return await Excel.run(async (context) => {
      const existing = context.workbook.names.getItemOrNullObject(SHORT_NAME);
      existing.load('formula');
      await context.sync();
      if (!existing.isNullObject) {
        return String(existing.formula || '').toUpperCase().includes(QUALIFIED_FUNCTION);
      }
      context.workbook.names.add(SHORT_NAME, SHORT_NAME_FORMULA, SHORT_NAME_COMMENT);
      await context.sync();
      return true;
    });
  } catch {
    // LAMBDA names need a recent Excel. =TAPESTRY.TAP works everywhere the add-in does.
    return false;
  }
}

export async function hasShortName(): Promise<boolean> {
  try {
    return await Excel.run(async (context) => {
      const existing = context.workbook.names.getItemOrNullObject(SHORT_NAME);
      existing.load('formula');
      await context.sync();
      return !existing.isNullObject && String(existing.formula || '').toUpperCase().includes(QUALIFIED_FUNCTION);
    });
  } catch {
    return false;
  }
}

export async function insertFormula(formula: string): Promise<string> {
  return Excel.run(async (context) => {
    const cell = context.workbook.getActiveCell();
    cell.formulas = [[formula]];
    cell.load('address');
    await context.sync();
    return cell.address;
  });
}

export async function activeCellFormula(): Promise<{ address: string; formula: string } | null> {
  try {
    return await Excel.run(async (context) => {
      const cell = context.workbook.getActiveCell();
      cell.load(['address', 'formulas']);
      await context.sync();
      const formula = cell.formulas?.[0]?.[0];
      return { address: cell.address, formula: typeof formula === 'string' ? formula : '' };
    });
  } catch {
    return null;
  }
}

/** Recalculate every formula, so each TAP cell asks again. */
export async function recalculateAll(): Promise<void> {
  await Excel.run(async (context) => {
    context.workbook.application.calculate(Excel.CalculationType.full);
    await context.sync();
  });
}

export async function onSelectionChanged(handler: () => void): Promise<void> {
  try {
    await Excel.run(async (context) => {
      context.workbook.onSelectionChanged.add(async () => { handler(); });
      await context.sync();
    });
  } catch {
    /* Older Excel: the pane still has its Edit button. */
  }
}
