import { browserStore, ExcelAuth, SESSION_KEY } from './lib/auth';
import { FUNCTION_ID } from './lib/formula';
import { GraphQLClient } from './lib/graphql';
import { TapClient } from './lib/tap-client';
import { ensureShortName, recalculateAll } from './office/workbook';
import { mountPane } from './ui/pane';

/**
 * The add-in's shared runtime: the TAP custom function, the ribbon's Refresh
 * command and the pane all run in this one page, so they share one sign-in.
 * The page is served by the web app, so /api/graphql is on the same origin.
 *
 * Starting up must never leave the pane on "Loading Tapestry…". Each step is
 * guarded, and anything that stops the pane from drawing is shown in it.
 */

/** How long Office may take to start the add-in before the pane says so. */
const OFFICE_START_TIMEOUT_MS = 20_000;

let mounted = false;

function showStartupProblem(message: string): void {
  if (mounted) return;
  const root = document.getElementById('app');
  if (!root) return;
  const title = document.createElement('p');
  title.className = 'status error';
  title.textContent = 'Tapestry could not start.';
  const detail = document.createElement('p');
  detail.className = 'help';
  detail.textContent = message;
  const hint = document.createElement('p');
  hint.className = 'help';
  hint.textContent = 'Close the pane and open it again. If this stays, send this message to your Tapestry administrator.';
  root.replaceChildren(title, detail, hint);
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

window.addEventListener('error', (event) => showStartupProblem(describe(event.error ?? event.message)));
window.addEventListener('unhandledrejection', (event) => showStartupProblem(describe(event.reason)));

const store = browserStore();
const auth = new ExcelAuth(store);
const graphql = new GraphQLClient(`${window.location.origin}/api/graphql`, auth);
const tap = new TapClient(graphql);

// Another workbook's add-in signed in, refreshed or signed out.
window.addEventListener('storage', (event) => {
  if (event.key === SESSION_KEY) auth.notifyExternalChange();
});

/**
 * =TAPESTRY.TAP(attribute, entity, [as_of]), and =TAP(...) through the workbook name.
 * @customfunction TAP
 */
async function tapFunction(attribute: unknown, entity: unknown, asOf?: unknown): Promise<number | string | boolean> {
  const result = await tap.cell(attribute, entity, asOf);
  if (result.ok) return result.value;
  const code = result.error === 'value' ? CustomFunctions.ErrorCode.invalidValue : CustomFunctions.ErrorCode.notAvailable;
  throw new CustomFunctions.Error(code, result.message.slice(0, 250));
}

try {
  if (typeof CustomFunctions !== 'undefined') CustomFunctions.associate(FUNCTION_ID, tapFunction);
} catch (error) {
  console.error('TAP could not be registered:', error);
}

function start(): void {
  const root = document.getElementById('app');
  if (root && !mounted) {
    try {
      mountPane(root, { auth, graphql, tap, persistentSignIn: store.persistent });
      mounted = true;
    } catch (error) {
      showStartupProblem(describe(error));
    }
  }

  // The ribbon's Refresh button. Older hosts have no Office.actions; the pane still refreshes.
  try {
    Office.actions?.associate('refreshTap', async (event: Office.AddinCommands.Event) => {
      try {
        await recalculateAll();
      } finally {
        event.completed();
      }
    });
  } catch (error) {
    console.error('Refresh TAP could not be registered:', error);
  }

  // Opening the pane is the moment to make =TAP(...) available in this workbook.
  if (mounted && auth.email()) void ensureShortName();
}

if (typeof Office === 'undefined') {
  showStartupProblem('Office.js did not load. Check that this computer can reach appsforoffice.microsoft.com.');
} else {
  Office.onReady(() => start()).catch((error: unknown) => showStartupProblem(describe(error)));
  setTimeout(() => {
    if (!mounted) showStartupProblem('Excel did not finish starting the add-in.');
  }, OFFICE_START_TIMEOUT_MS);
}
