/**
 * The screens a Stage step can put in front of a person.
 *
 * A Stage step names one of these. The run waits on it, the run's page shows
 * the screen, and the person leaves it with one of the screen's outcomes. A
 * screen can say what must be true before an outcome is accepted: the engine
 * asks a read-only tool and, when the answer does not hold up, hands the stage
 * back to the person with the reason.
 *
 * Pure, so the editor, the API, and the worker read a screen the same way. The
 * screen's own component lives in the web app, under the same code.
 */

export interface StageArg {
  key: string;
  label: string;
  help: string;
}

export interface StageExit {
  /** Outcomes the check applies to. Any other outcome is accepted as it is. */
  outcomes: string[];
  /** A read-only tool, asked as the run's starter. */
  tool: string;
  args(stageArgs: Record<string, unknown>, result: Record<string, unknown>): Record<string, unknown>;
  /** Why the stage cannot be left this way, or null when it can. */
  problem(output: unknown, result: Record<string, unknown>): string | null;
}

export interface StageScreen {
  code: string;
  label: string;
  description: string;
  /** Ways a person can leave the screen. Each connection leaving the step follows one. */
  outcomes: string[];
  /** What the person choosing an outcome must hold in the client, by outcome. */
  permissions: Record<string, string>;
  /** The values the screen is given, from the run. */
  args: StageArg[];
  exit?: StageExit;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const STAGE_SCREENS: readonly StageScreen[] = [
  {
    code: 'intake.understand',
    label: 'Understand a file',
    description: 'Shows a stored file beside what was found in it: what kind of file it is, its tables, the records it holds, and the stored record it is about. The person confirms before any column is mapped.',
    outcomes: ['confirmed', 'abandoned'],
    permissions: {},
    args: [{ key: 'importInstanceId', label: 'Stored file', help: 'The file to look at, usually {{input.importInstanceId}}.' }],
    exit: {
      outcomes: ['confirmed'],
      tool: 'get_position_file_understanding',
      args: (stageArgs) => ({ instanceId: text(stageArgs.importInstanceId) }),
      problem: (output) => {
        const file = record(output);
        if (!(Number(file.rowCount) > 0)) return 'Nothing was read from the table that is selected. Choose a table that has rows, or stop this run.';
        return null;
      },
    },
  },
  {
    code: 'load.map',
    label: 'Map a file',
    description: 'Shows a stored file beside where each of its columns will go. The person confirms the mapping and the date the values are as of.',
    outcomes: ['confirmed', 'abandoned'],
    permissions: {},
    args: [{ key: 'importInstanceId', label: 'Stored file', help: 'The file to map, usually {{input.importInstanceId}}.' }],
    exit: {
      outcomes: ['confirmed'],
      tool: 'get_position_file_import',
      args: (stageArgs) => ({ instanceId: text(stageArgs.importInstanceId) }),
      problem: (output) => {
        const file = record(output);
        const columns = Array.isArray(file.columnMappings) ? (file.columnMappings as Array<Record<string, unknown>>) : [];
        if (!text(file.asOfDate)) return 'Choose the date these values are as of.';
        if (!columns.some((column) => column.role === 'identity' || column.role === 'name')) {
          return 'Choose which column identifies each record.';
        }
        return null;
      },
    },
  },
  {
    code: 'load.quality',
    label: 'Check staged values',
    description: 'Shows a staged batch with its data quality checks. The person corrects what is wrong, then approves the batch to be promoted or discards it.',
    outcomes: ['approved', 'discarded'],
    permissions: { approved: 'load.promote' },
    args: [{ key: 'batchId', label: 'Staged batch', help: 'The batch to check, usually {{steps.stage.batch.id}}.' }],
    exit: {
      outcomes: ['approved'],
      tool: 'get_load_batch',
      args: (stageArgs) => ({ batchId: text(stageArgs.batchId) }),
      problem: (output, result) => {
        const batch = record(output);
        if (batch.status !== 'STAGED') return `This batch is ${String(batch.status || 'gone').toLowerCase()}, so it cannot be promoted.`;
        const blocking = Number(record(record(batch.quality).summary).blocking) || 0;
        if (blocking > 0 && !text(result.overrideReason)) {
          return `${blocking} critical ${blocking === 1 ? 'check fails' : 'checks fail'} because of this batch. Correct the values, or give a reason to promote anyway.`;
        }
        return null;
      },
    },
  },
  {
    code: 'nav.report',
    label: 'Check a filed report',
    description: 'Shows a stored financial report (a 10-Q, a 10-K, an annual report) beside how it maps onto its fund\'s NAV statement, with the reasons it needs a person at the top: the fund to choose when the report does not name one on file, the report\'s own checks, the lines with nowhere to go, and what a trial load would refuse or restate. The person loads it or stops the run.',
    outcomes: ['confirmed', 'abandoned'],
    permissions: {},
    args: [
      { key: 'importInstanceId', label: 'Stored file', help: 'The report, usually {{input.importInstanceId}}.' },
      { key: 'entityIds', label: 'Records the run was started on', help: 'Usually {{steps.select.entityIds}}. The first fund among them is the fund; with none, the fund the report names.' },
      { key: 'periodEnd', label: 'Period end', help: 'Usually {{input.periodEnd}}. Blank is the report\'s latest balance sheet date.' },
    ],
    exit: {
      outcomes: ['confirmed'],
      tool: 'get_nav_report',
      args: (stageArgs, result) => ({
        instanceId: text(stageArgs.importInstanceId),
        fundId: text(result.fundId) || undefined,
        entityIds: Array.isArray(stageArgs.entityIds) ? stageArgs.entityIds.map(String) : undefined,
        periodEnd: text(stageArgs.periodEnd) || undefined,
        trial: false,
      }),
      problem: (output) => {
        const report = record(output);
        if (report.ready === true) return null;
        if (!report.fund) return text(report.fundNote) || 'Choose the fund the report is for.';
        const problems = Array.isArray(report.problems) ? report.problems.map(String).filter(Boolean) : [];
        return problems.length ? problems.join(' ') : 'Nothing in this file maps onto the NAV statement at its period end.';
      },
    },
  },
];

export function stageScreen(code: unknown): StageScreen | null {
  return STAGE_SCREENS.find((screen) => screen.code === code) || null;
}

/** What the engine does with a stage a person has left: accept it, or hand it back with a reason. */
export function exitCheckFor(screen: StageScreen, outcome: string | null): StageExit | null {
  return screen.exit && outcome && screen.exit.outcomes.includes(outcome) ? screen.exit : null;
}
