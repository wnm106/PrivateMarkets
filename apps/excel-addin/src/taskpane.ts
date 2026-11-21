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
 */

const auth = new ExcelAuth(browserStore());
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

if (typeof CustomFunctions !== 'undefined') {
  CustomFunctions.associate(FUNCTION_ID, tapFunction);
}

Office.onReady(() => {
  // The ribbon's Refresh button.
  Office.actions?.associate('refreshTap', async (event: Office.AddinCommands.Event) => {
    try {
      await recalculateAll();
    } finally {
      event.completed();
    }
  });

  const root = document.getElementById('app');
  if (root) {
    mountPane(root, { auth, graphql, tap });
    // Opening the pane is the moment to make =TAP(...) available in this workbook.
    if (auth.email()) void ensureShortName();
  }
});
