import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph';

/**
 * Blocks: a run of steps that belong together, added to a workflow as one.
 *
 * A block is not a new kind of step. It is ordinary steps, wired the way the
 * platform already does the job, so a workflow that needs the job gets every
 * part of it and the run's page shows each part as its own step.
 *
 * The file import block is the standard way a file becomes live records: the
 * same loader, mapper, staging, data quality checks and promotion that Load
 * data uses. A workflow that takes a file uses this block; it does not map or
 * load a file any other way.
 * Pure, so the templates, the editor and the tests build the same steps.
 */

/** The steps of a file import, by what each does. */
export type FileImportStep = 'file' | 'index' | 'understand' | 'map' | 'stage' | 'staged' | 'quality' | 'promote' | 'discard';

export interface FileImportOptions {
  /** Put before each step's id, so a workflow can hold more than one import. */
  prefix?: string;
  /** Ids to use in place of the block's own, for a workflow whose steps are already known by other ids. */
  ids?: Partial<Record<FileImportStep, string>>;
  /**
   * A placeholder for the stored file, when the run already has it: "{{input.importInstanceId}}".
   * Left out, the block opens with a step where a person chooses the file or uploads it.
   */
  file?: string;
  /** What the person is told the run expects, on the step that receives the file. */
  expecting?: string;
  /** A placeholder for the run's records, or their codes or names, so their files are listed first. */
  about?: string;
  /** Where the block's first step sits on the canvas. */
  at?: { x: number; y: number };
}

/** A connection the block leaves open, for the workflow to take on. */
export interface BlockExit {
  from: string;
  when?: string;
}

export interface WorkflowBlock {
  nodes: WorkflowNode[];
  /** The connections inside the block. */
  edges: WorkflowEdge[];
  /** The step the workflow connects into. */
  entry: string;
  /** Leaves the block with the file's values live. */
  loaded: BlockExit;
  /** The person said there is no file to load. Only on a block that asks for the file. */
  noFile: BlockExit | null;
  /** Each way the import is stopped part way: a person stopped it, nothing could be staged, the batch was discarded. */
  stopped: BlockExit[];
  /** The stored file, as later steps read it. */
  file: string;
}

const GAP = 220;

/** The steps that take one file from received to live records, and how they connect. */
export function fileImportBlock(options: FileImportOptions = {}): WorkflowBlock {
  const prefix = options.prefix || '';
  const id = (step: FileImportStep) => options.ids?.[step] || `${prefix}${step}`;
  const origin = options.at || { x: 0, y: 160 };
  const asks = !options.file;
  const file = options.file || `{{steps.${id('file')}.result.importInstanceId}}`;
  let column = 0;
  const place = (dy = 0) => ({ x: origin.x + GAP * column++, y: origin.y + dy });
  const stage = (step: FileImportStep, label: string, screen: string, title: string, instructions: string, args: Record<string, unknown>): WorkflowNode => ({
    id: id(step),
    type: 'stage',
    label,
    position: place(),
    config: { screen, title, instructions, args, people: [], roles: [], dueInHours: null },
  });

  const nodes: WorkflowNode[] = [];
  if (asks) {
    nodes.push(
      stage('file', 'Receive the file', 'load.receive', 'Hand this run its file', 'Choose the file from those stored in Load data, or upload it. Look at it before you hand it on. If there is no file to load, say so and the run goes on without one.', {
        expecting: options.expecting || 'The file this run loads',
        about: options.about || '',
      }),
    );
  }
  nodes.push(
    { id: id('index'), type: 'tool', label: 'Index for search', position: place(), config: { tool: 'index_position_file_import', args: { instanceId: file }, allowWrite: true } },
    stage('understand', 'Understand the file', 'intake.understand', 'Confirm what this file is', 'Check what was read from the file, the kind of document it is, and the record it is about, before mapping its columns.', { importInstanceId: file }),
    stage('map', 'Map the file', 'load.map', 'Confirm where each column goes', 'Check what was found in the file, decide any column the reading was unsure of, and set the date the values are as of.', { importInstanceId: file }),
    {
      id: id('stage'),
      type: 'tool',
      label: 'Stage the values',
      position: place(),
      config: { tool: 'stage_position_file_import', args: { instanceId: file, resolutions: `{{steps.${id('map')}.result.resolutions}}` }, allowWrite: true },
    },
    { id: id('staged'), type: 'branch', label: 'Was it staged?', position: place(), config: { path: `steps.${id('stage')}.kind`, op: 'eq', value: 'staged' } },
    stage('quality', 'Check the values', 'load.quality', 'Check the staged values', 'Correct any value that fails a check, then approve the batch to make it live, or discard it.', { batchId: `{{steps.${id('stage')}.batch.id}}` }),
  );
  const at = place(-80);
  nodes.push(
    {
      id: id('promote'),
      type: 'tool',
      label: 'Promote to live records',
      position: at,
      config: { tool: 'promote_load_batch', args: { batchId: `{{steps.${id('stage')}.batch.id}}`, overrideReason: `{{steps.${id('quality')}.result.overrideReason}}` }, allowWrite: true },
    },
    { id: id('discard'), type: 'tool', label: 'Discard the batch', position: { x: at.x, y: origin.y + 100 }, config: { tool: 'discard_load_batch', args: { batchId: `{{steps.${id('stage')}.batch.id}}` }, allowWrite: true } },
  );

  const edges: WorkflowEdge[] = [];
  const connect = (from: FileImportStep, to: FileImportStep, when?: string) => edges.push({ id: `${prefix}i${edges.length + 1}`, from: id(from), to: id(to), ...(when ? { when } : {}) });
  if (asks) connect('file', 'index', 'received');
  connect('index', 'understand');
  connect('understand', 'map', 'confirmed');
  connect('map', 'stage', 'confirmed');
  connect('stage', 'staged');
  connect('staged', 'quality', 'true');
  connect('quality', 'promote', 'approved');
  connect('quality', 'discard', 'discarded');

  return {
    nodes,
    edges,
    entry: asks ? id('file') : id('index'),
    loaded: { from: id('promote') },
    noFile: asks ? { from: id('file'), when: 'none' } : null,
    stopped: [
      { from: id('understand'), when: 'abandoned' },
      { from: id('map'), when: 'abandoned' },
      { from: id('staged'), when: 'false' },
      { from: id('discard') },
    ],
    file,
  };
}

/**
 * The connections that take a block's open ends on: where the run goes once the file is loaded, where
 * it goes when there is no file, and where it goes when the import is stopped part way. Stopping an
 * import usually ends the run; having no file usually does not.
 */
export function blockExits(block: WorkflowBlock, to: { loaded: string; noFile?: string; stopped: string }, prefix = 'x'): WorkflowEdge[] {
  return [
    { ...block.loaded, to: to.loaded },
    ...(block.noFile ? [{ ...block.noFile, to: to.noFile || to.stopped }] : []),
    ...block.stopped.map((exit) => ({ ...exit, to: to.stopped })),
  ].map((edge, index) => ({ id: `${prefix}${index + 1}`, ...edge }));
}

/** How wide a block is on the canvas, so what follows it can be placed clear of it. */
export function blockWidth(block: WorkflowBlock): number {
  const xs = block.nodes.map((node) => node.position.x);
  return Math.max(...xs) - Math.min(...xs) + GAP;
}

/**
 * Adds a block to a graph the editor holds. Its step ids are made unique against the steps already
 * there, and its open ends are left for the person to connect: the editor names each one that is not.
 */
export function addFileImport(graph: WorkflowGraph, at: { x: number; y: number }): { graph: WorkflowGraph; entry: string } {
  const taken = new Set(graph.nodes.map((node) => node.id));
  let prefix = 'import_';
  for (let count = 2; taken.has(`${prefix}file`) || taken.has(`${prefix}index`); count += 1) prefix = `import${count}_`;
  const select = graph.nodes.find((node) => node.type === 'tool' && node.config.tool === 'find_records');
  const block = fileImportBlock({ prefix, at, about: select ? `{{steps.${select.id}.records}}` : '' });
  return { graph: { nodes: [...graph.nodes, ...block.nodes], edges: [...graph.edges, ...block.edges] }, entry: block.entry };
}
