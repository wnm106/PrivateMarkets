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
];

export function stageScreen(code: unknown): StageScreen | null {
  return STAGE_SCREENS.find((screen) => screen.code === code) || null;
}

/** What the engine does with a stage a person has left: accept it, or hand it back with a reason. */
export function exitCheckFor(screen: StageScreen, outcome: string | null): StageExit | null {
  return screen.exit && outcome && screen.exit.outcomes.includes(outcome) ? screen.exit : null;
}
