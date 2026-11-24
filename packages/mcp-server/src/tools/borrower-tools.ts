import { borrowerDigest, covenantUnit, figureText, type BorrowerFinancials, type OpenEntry } from '@tapestrai/graphql/src/lib/borrower-financials';
import { loadBorrowerFinancials, recalculateBorrowerCovenants, recordCovenantCertificate, saveBorrowerReview } from '@tapestrai/graphql/src/lib/borrower-financials-store';
import { selectedIds } from '@tapestrai/graphql/src/lib/workflow-filters';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * A borrower's financials, for workflows: the quarterly statements with how
 * the lines moved, every covenant on the borrower's deals tested under the
 * deal's own definition beside the borrower's certificate, and the changes a
 * reviewer can make: a certificate value, and the quarter's review notes.
 *
 * The reading tool returns what the Financials and covenant pages draw. The
 * statement lines themselves are loaded with the file tools, like any other
 * file. Nothing here waives a covenant or declares a default: that stays with
 * a person.
 */

function ids(args: Record<string, any>): string[] {
  const chosen = selectedIds(args.entityIds);
  if (chosen) return chosen;
  const one = String(args.entityId || '').trim();
  return one ? [one] : [];
}

const periodEnd = (args: Record<string, any>): string | null => (args.periodEnd ? String(args.periodEnd).slice(0, 10) : null);

/** Open items across several borrowers, each named by its borrower so a list of them still reads. */
function entriesAcross(all: BorrowerFinancials[]): OpenEntry[] {
  return all.flatMap((financials) => financials.entries.map((entry) => (all.length > 1 ? { ...entry, title: `${financials.borrower.name}: ${entry.title}` } : entry)));
}

function headlineAcross(all: BorrowerFinancials[]): string {
  if (all.length === 0) return 'No borrower was read.';
  if (all.length === 1) return all[0].headline;
  const sum = (pick: (financials: BorrowerFinancials) => number) => all.reduce((total, financials) => total + pick(financials), 0);
  const missing = all.filter((financials) => !financials.onFile).length;
  return `${all.length} borrowers: ${sum((f) => f.counts.breaches)} covenants past the limit, ${sum((f) => f.counts.watch)} close to it, ${sum((f) => f.counts.certificateDiffers)} certificate values differing from our calculation${missing > 0 ? `, ${missing} with no statement for the quarter` : ''}.`;
}

const getBorrowerFinancials: ToolDefinition = {
  name: 'get_borrower_financials',
  description:
    "A borrower's financials for one quarter. For each borrower: the statement lines for the last quarters (income statement, balance sheet, cash flow, as the Financials page shows them), how each key line moved on the quarter and on the year with the sharp moves marked, every covenant on the borrower's deals tested at the quarter end under the deal's own definition (limit, calculated value with its numerator and denominator, status PASS, WATCH, BREACH or NO_DATA, and cushion), what the borrower's compliance certificate says for the same covenant and whether it agrees with the calculation, the value under the house definition, and what is open (entries). Amounts are whole dollars; margins are fractions (0.136 is 13.6%); leverage and coverage are multiples. periodEnd is the quarter end; leave it out for the latest quarter that has ended. A covenant's calculated value is the platform's: do not recalculate it by hand, explain it from the lines.",
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      entityIds: { type: 'array', items: { type: 'string' }, description: 'The borrowers, by record id.' },
      periodEnd: { type: 'string', description: 'Quarter end, YYYY-MM-DD. Leave out for the latest quarter that has ended.' },
      allLines: { type: 'boolean', description: 'True for every statement line. The default is the key lines: headline figures, totals and margins.' },
      quarters: { type: 'number', description: 'Quarters to show, ending at periodEnd. Default 6, at most 12.' },
    },
    required: ['entityIds'],
  },
  execute: async (args, supabase) => {
    const chosen = ids(args);
    if (chosen.length === 0) return { count: 0, borrowers: [], entries: [], headline: 'No borrower was chosen.' };
    const quarters = Math.min(12, Math.max(2, Number(args.quarters) || 6));
    const loaded = await Promise.all(chosen.slice(0, 50).map((id) => loadBorrowerFinancials(supabase, id, periodEnd(args), null, null, quarters)));
    const all = loaded.map((load) => load.financials);
    const borrowers = all.filter((financials) => !financials.note);
    const notBorrowers = all.filter((financials) => financials.note).map((financials) => financials.borrower.name);
    return {
      count: borrowers.length,
      periodEnd: borrowers[0]?.periodEnd || periodEnd(args),
      headline: headlineAcross(borrowers),
      ...(notBorrowers.length > 0 ? { notBorrowers, note: `${notBorrowers.length} selected record${notBorrowers.length === 1 ? ' has' : 's have'} no statements and no deals, and ${notBorrowers.length === 1 ? 'is' : 'are'} left out.` } : {}),
      reviewNotesCanBeKept: loaded.some((load) => load.notesKept),
      borrowers: borrowers.map((financials) => borrowerDigest(financials, { allLines: args.allLines === true })),
      entries: entriesAcross(borrowers),
    };
  },
};

const recalculateCovenants: ToolDefinition = {
  name: 'recalculate_borrower_covenants',
  description:
    "Store every covenant on a borrower's deals again from its definition and the statement lines now on file, and rewrite the covenant section of the borrower's statements. Use it after statement lines are loaded or corrected, so the stored values are current. It changes no statement line, limit or definition.",
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      entityIds: { type: 'array', items: { type: 'string' }, description: 'The borrowers, by record id.' },
      periodEnd: { type: 'string', description: 'Quarter end the result is read at, YYYY-MM-DD. Leave out for the latest quarter that has ended.' },
    },
    required: ['entityIds'],
  },
  execute: async (args, supabase) => {
    const chosen = ids(args);
    const results = [];
    for (const id of chosen.slice(0, 50)) results.push(await recalculateBorrowerCovenants(supabase, id, periodEnd(args)));
    const recalculated = results.reduce((total, row) => total + row.recalculated, 0);
    const wereBehind = results.reduce((total, row) => total + row.wereBehind, 0);
    const failed = results.flatMap((row) => row.failed.map((failure) => ({ borrower: row.borrower.name, ...failure })));
    return {
      borrowers: results.length,
      recalculated,
      wereBehind,
      failed,
      headline: `Stored ${recalculated} covenant${recalculated === 1 ? '' : 's'} again${wereBehind > 0 ? `; ${wereBehind} ${wereBehind === 1 ? 'was' : 'were'} behind the definition` : '; none was behind'}${failed.length > 0 ? `. ${failed.length} could not be recalculated` : ''}.`,
    };
  },
};

const recordCertificate: ToolDefinition = {
  name: 'record_borrower_covenant_value',
  description:
    "Record what the borrower's compliance certificate says one covenant was at a quarter end. entityId is the covenant record (covenantId from get_borrower_financials). The value is filed under the Borrower Compliance Certificate source, which ranks behind the platform's own calculation: the calculation stays the golden value, and the two are shown side by side. Give the figure exactly as certified: a multiple as a number (4.94), an amount in whole dollars. Recording it again for the same quarter replaces it. It does not waive or cure anything.",
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'The covenant record id: covenantId from get_borrower_financials.' },
      testDate: { type: 'string', description: 'The quarter end the certificate tests, YYYY-MM-DD.' },
      value: { type: 'number', description: 'The figure on the certificate.' },
      note: { type: 'string', description: 'Where the figure is in the certificate: the file, the schedule and the line.' },
    },
    required: ['entityId', 'testDate', 'value'],
  },
  execute: async (args, supabase) => {
    const result = await recordCovenantCertificate(supabase, { covenantId: String(args.entityId || ''), testDate: String(args.testDate || ''), value: Number(args.value), note: args.note ? String(args.note) : undefined });
    const unit = covenantUnit(result.unit);
    return { ...result, headline: `${result.covenant}: ${figureText(result.certificate, unit)} on the certificate, ${figureText(result.calculated, unit)} calculated.` };
  },
};

const saveReview: ToolDefinition = {
  name: 'save_borrower_review',
  description:
    "Keep the review notes for one borrower and one quarter on that quarter's statement, where the borrower's financials show them. notes is the full write-up in Markdown. Replaces notes saved earlier for the same quarter; earlier versions stay in the record's history. Beside the notes the platform stores a one-line outcome that it reads from the covenants and the lines at the moment of saving, so make this the last change applied.",
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'The borrower record id.' },
      periodEnd: { type: 'string', description: 'Quarter end, YYYY-MM-DD. Leave out for the latest quarter that has ended.' },
      notes: { type: 'string', description: 'The notes, in Markdown.' },
    },
    required: ['entityId', 'notes'],
  },
  execute: async (args, supabase) => saveBorrowerReview(supabase, { borrowerId: String(args.entityId || ''), periodEnd: periodEnd(args), notes: String(args.notes || '') }),
};

export function registerBorrowerTools(registry: ToolRegistry) {
  registry.registerTool(getBorrowerFinancials);
  registry.registerTool(recalculateCovenants);
  registry.registerTool(recordCertificate);
  registry.registerTool(saveReview);
}
