/**
 * The stored files a person chooses from when a run asks for its file.
 *
 * The list is every file in Load data. What a person most likely wants comes
 * first: a file that names one of the run's records, then a file not loaded
 * yet, then the newest. Each says where it stands, so a file already loaded is
 * not handed over by mistake.
 * Pure, so the screen and the tests order the files the same way.
 */

export interface StoredFile {
  id: string;
  fileName: string;
  status: string;
  receivedAt: string;
  completedAt?: string | null;
  rowCount: number;
  asOfDate?: string | null;
  mapName?: string | null;
  mapSaved?: boolean;
  errorMessage?: string | null;
  resultSummary?: { created: number; matched: number; failed: number } | null;
}

export interface FileChoice {
  file: StoredFile;
  /** The record of the run this file's name mentions, as the run names it. */
  mentions: string | null;
  /** Its values have been loaded before. Loading it again states them again. */
  loaded: boolean;
  /** Where the file stands, in a few words. */
  standing: string;
  tone: 'new' | 'loaded' | 'trouble';
}

/** Words too common in codes and file names to tell one record from another. */
const COMMON = new Set(['fund', 'file', 'data', 'load', 'report', 'statement', 'statements', 'final', 'copy', 'holdings', 'limited', 'corp', 'group', 'capital', 'partners', 'systems', 'services', 'energy', 'international']);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !COMMON.has(word) && !/^\d+$/.test(word));
}

/** A record of the run, as a file's name is checked against it. */
interface AboutRecord {
  /** How the record is named to the person: its name, or its code when that is all there is. */
  name: string;
  words: string[];
}

function clean(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/**
 * The records a run is about, however the step passed them: the records a selection step returned
 * (each with a name and a code), a list of codes or names, or one line of text.
 */
function aboutRecords(about: unknown): AboutRecord[] {
  const list = Array.isArray(about) ? about : typeof about === 'string' ? about.split(/[,;\n]+/) : [];
  const records: AboutRecord[] = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const row = entry as Record<string, unknown>;
      const name = clean(row.entityName) || clean(row.name);
      const code = clean(row.entityCode) || clean(row.code);
      if (name || code) records.push({ name: name || code, words: [...words(name), ...words(code)] });
    } else if (clean(entry)) {
      records.push({ name: clean(entry), words: words(clean(entry)) });
    }
  }
  return records;
}

/** The names of the records a run is about, for telling the person. */
export function aboutList(about: unknown): string[] {
  return aboutRecords(about).map((record) => record.name);
}

function standingOf(file: StoredFile): Pick<FileChoice, 'loaded' | 'standing' | 'tone'> {
  if (file.status === 'PROCESSING') return { loaded: false, standing: 'Being loaded now', tone: 'trouble' };
  if (file.status === 'FAILED') return { loaded: false, standing: 'Its last load failed', tone: 'trouble' };
  if (file.status === 'NEEDS_RESOLUTION') return { loaded: false, standing: 'Its last load stopped for a question', tone: 'trouble' };
  if (file.resultSummary) {
    const day = (file.completedAt || '').slice(0, 10);
    return { loaded: true, standing: day ? `Loaded on ${day}` : 'Loaded before', tone: 'loaded' };
  }
  return { loaded: false, standing: 'Not loaded yet', tone: 'new' };
}

/** The stored files in the order a person should look at them, each with where it stands. */
export function fileChoices(files: readonly StoredFile[], about: unknown = []): FileChoice[] {
  const records = aboutRecords(about);
  const choices = files.map((file): FileChoice => {
    const inName = new Set(words(file.fileName));
    const mentions = records.find((record) => record.words.some((word) => inName.has(word)))?.name || null;
    return { file, mentions, ...standingOf(file) };
  });
  const rank = (choice: FileChoice) => (choice.mentions ? 0 : 2) + (choice.loaded ? 1 : 0);
  return choices
    .map((choice, index) => ({ choice, index }))
    .sort((a, b) => rank(a.choice) - rank(b.choice) || Date.parse(b.choice.file.receivedAt) - Date.parse(a.choice.file.receivedAt) || a.index - b.index)
    .map(({ choice }) => choice);
}

/**
 * The file to open before the person has chosen: the one file not loaded yet that names a record of
 * the run. With two or more, none is opened: which one the run wants is the person's to say.
 */
export function likelyChoice(choices: readonly FileChoice[]): FileChoice | null {
  const likely = choices.filter((choice) => choice.mentions && choice.tone === 'new');
  return likely.length === 1 ? likely[0] : null;
}

/** The list narrowed to the files whose name holds every word typed. */
export function searchChoices(choices: readonly FileChoice[], typed: string): FileChoice[] {
  const wanted = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (wanted.length === 0) return [...choices];
  return choices.filter((choice) => wanted.every((word) => choice.file.fileName.toLowerCase().includes(word)));
}
