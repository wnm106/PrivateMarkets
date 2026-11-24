import { describe, expect, it } from 'vitest';
import { addFileImport, blockExits, fileImportBlock } from './workflow-blocks';
import { nextNode, validateGraph, type WorkflowGraph } from './workflow-graph';
import { stageScreen } from './workflow-screens';
import { WORKFLOW_TEMPLATES } from './workflow-templates';

const template = (code: string) => WORKFLOW_TEMPLATES.find((entry) => entry.code === code)!.graph;

function around(block: ReturnType<typeof fileImportBlock>): WorkflowGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 }, config: {} },
      ...block.nodes,
      { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [{ id: 's', from: 'start', to: block.entry }, ...block.edges, ...blockExits(block, { loaded: 'end', stopped: 'end' })],
  };
}

describe('the file import block', () => {
  it('is a sound run of steps once its open ends are connected', () => {
    expect(validateGraph(around(fileImportBlock()))).toEqual([]);
    expect(validateGraph(around(fileImportBlock({ file: '{{input.importInstanceId}}' })))).toEqual([]);
  });

  it('opens with a person handing over the file, unless the run already has it', () => {
    const asks = fileImportBlock({ expecting: 'The statements', about: '{{steps.select.records}}' });
    expect(asks.entry).toBe('file');
    expect(asks.nodes[0].config).toMatchObject({ screen: 'load.receive', args: { expecting: 'The statements', about: '{{steps.select.records}}' } });
    expect(asks.file).toBe('{{steps.file.result.importInstanceId}}');
    expect(asks.noFile).toEqual({ from: 'file', when: 'none' });

    const given = fileImportBlock({ file: '{{input.importInstanceId}}' });
    expect(given.entry).toBe('index');
    expect(given.noFile).toBeNull();
    expect(given.nodes.some((node) => node.config.screen === 'load.receive')).toBe(false);
  });

  it('uses the standard loader for every part: the same screens and tools as Load data', () => {
    const block = fileImportBlock();
    expect(block.nodes.filter((node) => node.type === 'stage').map((node) => node.config.screen)).toEqual(['load.receive', 'intake.understand', 'load.map', 'load.quality']);
    expect(block.nodes.filter((node) => node.type === 'tool').map((node) => node.config.tool)).toEqual(['index_position_file_import', 'stage_position_file_import', 'promote_load_batch', 'discard_load_batch']);
    // Every later step reads the file the person handed over.
    for (const id of ['index', 'understand', 'map', 'stage']) {
      expect(JSON.stringify(block.nodes.find((node) => node.id === id)!.config)).toContain('{{steps.file.result.importInstanceId}}');
    }
  });

  it('leaves one way out loaded, one for no file, and names each way it can be stopped', () => {
    const block = fileImportBlock();
    expect(block.loaded).toEqual({ from: 'promote' });
    expect(block.noFile).toEqual({ from: 'file', when: 'none' });
    expect(block.stopped).toEqual([
      { from: 'understand', when: 'abandoned' },
      { from: 'map', when: 'abandoned' },
      { from: 'staged', when: 'false' },
      { from: 'discard' },
    ]);
  });

  it('keeps two imports in one workflow apart', () => {
    const blank = template('BLANK');
    const once = addFileImport(blank, { x: 300, y: 200 });
    const twice = addFileImport(once.graph, { x: 300, y: 500 });
    expect(once.entry).toBe('import_file');
    expect(twice.entry).toBe('import2_file');
    const ids = twice.graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const edges = twice.graph.edges.map((edge) => edge.id);
    expect(new Set(edges).size).toBe(edges.length);
    // Until its ends are connected the editor says which are open.
    expect(validateGraph(once.graph).some((problem) => problem.nodeId === 'import_file')).toBe(true);
  });

  it('lists the files of the run’s records first when the workflow selects records', () => {
    const added = addFileImport(template('DATA_QUALITY_BRIEF'), { x: 0, y: 0 });
    expect(added.graph.nodes.find((node) => node.id === 'import_file')!.config.args).toMatchObject({ about: '{{steps.select.records}}' });
  });
});

describe('templates that take a file', () => {
  it('File intake is the block on the file the run was started with', () => {
    const graph = template('FILE_INTAKE');
    expect(validateGraph(graph)).toEqual([]);
    expect(graph.nodes.map((node) => node.id)).toEqual(['start', 'receive', 'understand', 'map', 'stage', 'staged', 'quality', 'promote', 'discard', 'end']);
  });

  it('Borrower financials loads through the block, and reviews what is on file when there is no file', () => {
    const graph = template('BORROWER_FINANCIALS');
    expect(validateGraph(graph)).toEqual([]);
    expect(graph.nodes.some((node) => node.type === 'agent' && (node.config.proposable as string[]).includes('load_position_file_table'))).toBe(false);
    expect(graph.edges.find((edge) => edge.from === 'promote')?.to).toBe('recalculate');
    // With no file nothing says which issuer to review, so the run ends.
    expect(graph.edges.find((edge) => edge.from === 'file' && edge.when === 'none')?.to).toBe('end');
    // Stopping the import part way ends the run, as it does in File intake.
    for (const [from, when] of [['understand', 'abandoned'], ['map', 'abandoned'], ['staged', 'false']]) {
      expect(graph.edges.find((edge) => edge.from === from && edge.when === when)?.to).toBe('end');
    }
    expect(graph.edges.find((edge) => edge.from === 'discard')?.to).toBe('end');
  });

  it('Borrower financials starts with the file and finds the issuer in it, asking a person only when the file does not name one', () => {
    const graph = template('BORROWER_FINANCIALS');
    expect(nextNode(graph, 'start', null)?.id).toBe('file');
    const to = (from: string, when?: string) => graph.edges.find((edge) => edge.from === from && (when === undefined || edge.when === when))?.to;
    // The issuer is settled and the "before" figures are read before the file is understood, mapped or loaded.
    expect(to('index')).toBe('identify');
    expect(to('identified', 'true')).toBe('select');
    expect(to('identified', 'false')).toBe('pick');
    expect(to('pick', 'chosen')).toBe('select');
    expect(to('pick', 'none')).toBe('end');
    expect(to('select')).toBe('before');
    expect(to('any', 'true')).toBe('understand');
    expect(graph.edges.some((edge) => edge.from === 'index' && edge.to === 'understand')).toBe(false);
    expect(graph.nodes.find((node) => node.id === 'pick')?.config).toMatchObject({ screen: 'intake.record', args: { recordType: 'ISSUER' } });
    expect(graph.nodes.some((node) => node.config.tool === 'find_records')).toBe(false);
  });

  it('the screen that chooses a record is left only with a record of the type', () => {
    const screen = stageScreen('intake.record')!;
    expect(screen.outcomes).toEqual(['chosen', 'none']);
    const args = screen.exit!.args({ importInstanceId: 'f1', recordType: 'ISSUER' }, { entityId: 'e1' });
    expect(args).toEqual({ instanceId: 'f1', recordType: 'ISSUER', entityId: 'e1' });
    expect(screen.exit!.problem({ identified: true }, { entityId: 'e1' })).toBeNull();
    expect(screen.exit!.problem({ identified: false }, { entityId: 'e1' })).toMatch(/not a stored record/);
    expect(screen.exit!.problem({}, {})).toMatch(/Choose the record/);
  });

  it('the screen that receives a file needs only what the run expects', () => {
    const screen = stageScreen('load.receive')!;
    expect(screen.outcomes).toEqual(['received', 'none']);
    expect(screen.args.filter((arg) => !arg.optional).map((arg) => arg.key)).toEqual(['expecting']);
    expect(screen.exit!.problem({ id: 'f1' }, { importInstanceId: 'f1' })).toBeNull();
    expect(screen.exit!.problem({}, { importInstanceId: 'f1' })).toMatch(/no longer stored/);
    expect(screen.exit!.problem({ id: 'f1' }, {})).toMatch(/Choose the file/);
  });
});
