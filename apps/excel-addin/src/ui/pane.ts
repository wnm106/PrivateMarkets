import type { ExcelAuth } from '../lib/auth';
import { asOfArgument, buildTapFormula, parseTapFormula, type FormulaArgument, type TapFormula } from '../lib/formula';
import type { GraphQLClient } from '../lib/graphql';
import {
  attributeChoices,
  entityChoices,
  groupAttributeChoices,
  SEARCH_ATTRIBUTES_QUERY,
  SEARCH_ENTITIES_QUERY,
  type AttributeChoice,
  type AttributeHit,
  type EntityChoice,
  type EntityHit,
} from '../lib/search';
import { cellResult, errorResult, tapRequestFromArguments, type TapClient } from '../lib/tap-client';
import { signInWithDialog } from '../office/sign-in';
import { h } from './dom';
import { mountOverrides } from './overrides';
import { mountTables } from './tables';
import type { TableSync } from '../office/table-sync';
import { activeCellFormula, ensureShortName, hasShortName, insertFormula, onSelectionChanged, recalculateAll } from '../office/workbook';

/**
 * The Tapestry pane: who is signed in, and a formula builder that searches
 * attributes first, then records, then takes an optional as-of date.
 * Every string from the server is set as text, never as HTML.
 */

interface Services {
  auth: ExcelAuth;
  graphql: GraphQLClient;
  tap: TapClient;
  /** False when the browser blocks storage for the add-in, so a sign-in lasts only while the workbook is open. */
  persistentSignIn?: boolean;
  /** The workbook's synced tables. */
  tables?: TableSync;
}

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatValue(value: number | string | boolean): string {
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
}

export function mountPane(root: HTMLElement, services: Services): void {
  const { auth, graphql, tap } = services;

  let attribute: AttributeChoice | null = null;
  let entity: EntityChoice | null = null;
  let useShortName = false;
  let previewToken = 0;

  // Account
  const account = h('section', { className: 'account' });
  const status = h('p', { className: 'status', role: 'status', 'aria-live': 'polite' });

  // Builder
  const attributeInput = h('input', { id: 'attribute', type: 'search', autocomplete: 'off', placeholder: 'Search attributes: NAV, coupon, rating…', spellcheck: 'false' });
  const attributeResults = h('ul', { className: 'results', role: 'listbox', 'aria-label': 'Attributes' });
  const attributePicked = h('p', { className: 'picked' });
  const entityInput = h('input', { id: 'entity', type: 'search', autocomplete: 'off', placeholder: 'Search records by code or name', spellcheck: 'false' });
  const entityResults = h('ul', { className: 'results', role: 'listbox', 'aria-label': 'Records' });
  const entityPicked = h('p', { className: 'picked' });
  const asOfInput = h('input', { id: 'asof', type: 'text', autocomplete: 'off', placeholder: 'Blank for today, 2026-09-30, or a cell like B1', spellcheck: 'false' });
  const asOfPicker = h('input', { type: 'date', 'aria-label': 'Pick an as-of date', className: 'date-picker' });
  const formulaPreview = h('code', { className: 'formula' }, ['=TAP("attribute", "record", "as of")']);
  const valuePreview = h('p', { className: 'value', 'aria-live': 'polite' });
  const insertButton = h('button', { type: 'button', className: 'primary', disabled: true }, ['Insert in selected cell']);
  const clearButton = h('button', { type: 'button' }, ['Clear']);
  const selectionNote = h('div', { className: 'selection', hidden: true });
  const refreshButton = h('button', { type: 'button' }, ['Refresh TAP formulas']);

  const setStatus = (text: string, tone: 'info' | 'error' = 'info') => {
    status.textContent = text;
    status.className = `status ${tone}`;
  };

  // ---- Account ----
  const renderAccount = () => {
    account.replaceChildren();
    const email = auth.email();
    if (email) {
      const clientName = auth.clientName();
      account.append(
        h('p', { className: 'who' }, [
          'Signed in as ',
          h('strong', {}, [email]),
          ...(clientName ? [' in ', h('strong', {}, [clientName])] : []),
        ]),
        h('button', { type: 'button', onClick: () => { void signOut(); } }, ['Sign out']),
      );
      if (clientName) {
        account.append(h('p', { className: 'help' }, [
          'Formulas and tables read this client only. To work in another client, sign out and sign in again.',
        ]));
      }
      if (services.persistentSignIn === false) {
        account.append(h('p', { className: 'help' }, [
          'This browser blocks storage for add-ins, so you will sign in again each time you open the workbook.',
        ]));
      }
    } else {
      account.append(
        h('p', { className: 'who' }, ['Sign in with your Tapestry account. Formulas show only what your account can see.']),
        h('button', { type: 'button', className: 'primary', onClick: () => { void signIn(); } }, ['Sign in']),
      );
    }
  };

  const signIn = async () => {
    setStatus('Opening sign-in…');
    const result = await signInWithDialog(auth);
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    setStatus('Signed in. Recalculating TAP formulas…');
    useShortName = await ensureShortName();
    await recalculateAll().catch(() => undefined);
    setStatus('Signed in.');
    updatePreview();
  };

  const signOut = async () => {
    await auth.signOut();
    setStatus('Signed out. TAP cells show #N/A until you sign in again.');
    await recalculateAll().catch(() => undefined);
  };

  // ---- Attribute search ----
  const renderAttributeChoices = (choices: AttributeChoice[]) => {
    const row = (choice: AttributeChoice) => h('li', {}, [
      h('button', { type: 'button', role: 'option', className: 'choice', onClick: () => pickAttribute(choice) }, [
        h('span', { className: 'code' }, [choice.code]),
        h('span', { className: 'label' }, [choice.label]),
        choice.detail ? h('span', { className: 'detail' }, [choice.detail]) : null,
      ]),
    ]);
    const items: Node[] = [];
    for (const group of groupAttributeChoices(choices)) {
      items.push(h('li', { className: 'divider group', role: 'presentation' }, [group.domainCode || 'No entity type']));
      items.push(...group.choices.map(row));
    }
    if (!choices.length && attributeInput.value.trim().length >= 2) {
      items.push(h('li', { className: 'empty' }, ['No attribute matches. A code typed here is used as written.']));
    }
    attributeResults.replaceChildren(...items);
  };

  const searchAttributes = debounce(async (query: string) => {
    if (query.trim().length < 2 || !auth.email()) {
      attributeResults.replaceChildren();
      return;
    }
    try {
      const data = await graphql.request<{ searchAttributes: { attributes: AttributeHit[]; entityNames: AttributeHit[] } }>(
        SEARCH_ATTRIBUTES_QUERY,
        { query, limit: 20 },
      );
      if (attributeInput.value !== query) return;
      renderAttributeChoices(attributeChoices(data.searchAttributes));
      updatePreview();
    } catch (error) {
      const result = errorResult(error);
      attributeResults.replaceChildren(h('li', { className: 'empty' }, [result.ok ? '' : result.message]));
    }
  }, 250);

  const pickAttribute = (choice: AttributeChoice) => {
    attribute = choice;
    attributeInput.value = choice.code;
    attributeResults.replaceChildren();
    attributePicked.textContent = [choice.label, choice.domainCode, choice.detail].filter(Boolean).join(' · ');
    setEntityScope();
    entityInput.focus();
    if (entityInput.value.trim()) void searchEntities(entityInput.value);
    updatePreview();
  };

  // ---- Record search ----
  /** Once an attribute is picked, records are searched within its entity type only. */
  const entityScope = () => attribute?.domainCode || null;
  const setEntityScope = () => {
    const scope = entityScope();
    entityInput.placeholder = scope ? `Search ${scope} records by code or name` : 'Search records by code or name';
  };

  const renderEntityChoices = (choices: EntityChoice[]) => {
    const fitting = choices.filter((choice) => choice.fitsAttribute);
    const others = choices.filter((choice) => !choice.fitsAttribute);
    const row = (choice: EntityChoice) => h('li', {}, [
      h('button', { type: 'button', role: 'option', className: `choice${choice.fitsAttribute ? '' : ' muted'}`, onClick: () => pickEntity(choice) }, [
        h('span', { className: 'code' }, [choice.code]),
        h('span', { className: 'label' }, [choice.label]),
        choice.detail ? h('span', { className: 'detail' }, [choice.detail]) : null,
      ]),
    ]);
    const items: Node[] = fitting.map(row);
    if (others.length) {
      if (attribute?.domainCode && fitting.length) items.push(h('li', { className: 'divider' }, [`Other entity types (no ${attribute.code})`]));
      items.push(...others.map(row));
    }
    if (!items.length && entityInput.value.trim().length >= 2) {
      const scope = entityScope();
      items.push(h('li', { className: 'empty' }, [
        scope ? `No ${scope} record matches. A code typed here is used as written.` : 'No record matches. A code typed here is used as written.',
      ]));
    }
    entityResults.replaceChildren(...items);
  };

  const searchEntities = debounce(async (query: string) => {
    if (query.trim().length < 2 || !auth.email()) {
      entityResults.replaceChildren();
      return;
    }
    try {
      const scope = entityScope();
      const data = await graphql.request<{ searchEntities: EntityHit[] }>(SEARCH_ENTITIES_QUERY, { query, limit: 30, domainCode: scope });
      if (entityInput.value !== query || entityScope() !== scope) return;
      renderEntityChoices(entityChoices(data.searchEntities, scope));
      updatePreview();
    } catch (error) {
      const result = errorResult(error);
      entityResults.replaceChildren(h('li', { className: 'empty' }, [result.ok ? '' : result.message]));
    }
  }, 250);

  const pickEntity = (choice: EntityChoice) => {
    entity = choice;
    entityInput.value = choice.code;
    entityResults.replaceChildren();
    entityPicked.textContent = `${choice.label}${choice.detail ? ` · ${choice.detail}` : ''}`;
    asOfInput.focus();
    updatePreview();
  };

  // ---- Formula ----
  const currentFormula = (): TapFormula | null => {
    const attributeText = attributeInput.value.trim();
    const entityText = entityInput.value.trim();
    if (!attributeText || !entityText) return null;
    const asText = (value: string): FormulaArgument => ({ kind: 'text', value });
    return { attribute: asText(attributeText), entity: asText(entityText), asOf: asOfArgument(asOfInput.value) };
  };

  const updatePreview = debounce(() => {
    const formula = currentFormula();
    insertButton.disabled = !formula;
    if (!formula) {
      formulaPreview.textContent = '=TAP("attribute", "record", "as of")';
      valuePreview.textContent = '';
      return;
    }
    formulaPreview.textContent = buildTapFormula(formula, useShortName);
    if (!auth.email()) {
      valuePreview.textContent = 'Sign in to preview the value.';
      valuePreview.className = 'value muted';
      return;
    }
    if (attributeResults.querySelector('.choice') || entityResults.querySelector('.choice')) {
      valuePreview.textContent = 'Pick from the list, or keep typing a code.';
      valuePreview.className = 'value muted';
      return;
    }
    if (formula.asOf?.kind === 'expression') {
      valuePreview.textContent = `The value is read as of the date in ${formula.asOf.value}.`;
      valuePreview.className = 'value muted';
      return;
    }
    const parsed = tapRequestFromArguments(formula.attribute.value, formula.entity.value, formula.asOf?.value ?? null);
    if (!parsed.ok) {
      valuePreview.textContent = parsed.result.ok ? '' : parsed.result.message;
      valuePreview.className = 'value error';
      return;
    }
    const token = ++previewToken;
    valuePreview.textContent = 'Reading…';
    valuePreview.className = 'value muted';
    void tap.value(parsed.request)
      .then((answer) => {
        if (token !== previewToken) return;
        const result = cellResult(answer);
        if (result.ok) {
          const about = [answer.entityName, answer.attributeName].filter(Boolean).join(' · ');
          valuePreview.textContent = `${formatValue(result.value)}${about ? `  —  ${about}` : ''}${answer.validFrom ? ` (since ${answer.validFrom})` : ''}`;
          valuePreview.className = 'value';
        } else {
          valuePreview.textContent = `${result.error === 'value' ? '#VALUE!' : '#N/A'}  ${result.message}`;
          valuePreview.className = 'value error';
        }
      })
      .catch((error) => {
        if (token !== previewToken) return;
        const result = errorResult(error);
        valuePreview.textContent = result.ok ? '' : `#N/A  ${result.message}`;
        valuePreview.className = 'value error';
      });
  }, 300);

  const insert = async () => {
    const formula = currentFormula();
    if (!formula) return;
    try {
      useShortName = await ensureShortName();
      const text = buildTapFormula(formula, useShortName);
      const address = await insertFormula(text);
      setStatus(`Inserted in ${address}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The formula could not be inserted.', 'error');
    }
  };

  const clear = () => {
    attribute = null;
    entity = null;
    attributeInput.value = '';
    entityInput.value = '';
    asOfInput.value = '';
    attributePicked.textContent = '';
    entityPicked.textContent = '';
    attributeResults.replaceChildren();
    entityResults.replaceChildren();
    setEntityScope();
    updatePreview();
    attributeInput.focus();
  };

  // ---- Editing a selected TAP cell ----
  const loadIntoBuilder = (parsed: TapFormula) => {
    attribute = null;
    entity = null;
    attributeInput.value = parsed.attribute.value;
    entityInput.value = parsed.entity.value;
    asOfInput.value = parsed.asOf?.value || '';
    attributePicked.textContent = parsed.attribute.kind === 'expression' ? 'From a cell or expression' : '';
    entityPicked.textContent = parsed.entity.kind === 'expression' ? 'From a cell or expression' : '';
    setEntityScope();
    updatePreview();
  };

  const checkSelection = async () => {
    const cell = await activeCellFormula();
    const parsed = cell ? parseTapFormula(cell.formula) : null;
    if (!cell || !parsed) {
      selectionNote.hidden = true;
      return;
    }
    selectionNote.replaceChildren(
      h('span', {}, [`${cell.address} has a TAP formula.`]),
      h('button', { type: 'button', onClick: () => loadIntoBuilder(parsed) }, ['Edit in builder']),
    );
    selectionNote.hidden = false;
  };

  // ---- Wiring ----
  attributeInput.addEventListener('input', () => {
    if (attribute && attributeInput.value !== attribute.code) {
      attribute = null;
      attributePicked.textContent = '';
      setEntityScope();
      if (entityInput.value.trim() && !entity) void searchEntities(entityInput.value);
    }
    void searchAttributes(attributeInput.value);
    updatePreview();
  });
  entityInput.addEventListener('input', () => {
    if (entity && entityInput.value !== entity.code) {
      entity = null;
      entityPicked.textContent = '';
    }
    void searchEntities(entityInput.value);
    updatePreview();
  });
  asOfInput.addEventListener('input', () => updatePreview());
  asOfPicker.addEventListener('change', () => {
    asOfInput.value = asOfPicker.value;
    updatePreview();
  });
  insertButton.addEventListener('click', () => { void insert(); });
  clearButton.addEventListener('click', clear);
  refreshButton.addEventListener('click', () => {
    setStatus('Recalculating…');
    void recalculateAll().then(() => setStatus('TAP formulas recalculated.')).catch((error) => setStatus(String(error?.message || error), 'error'));
  });

  const overrides = h('section', { className: 'overrides' });
  mountOverrides(overrides, { auth, graphql, setStatus, afterSave: () => recalculateAll() });
  const tablesSection = h('section', { className: 'tables' });
  if (services.tables) mountTables(tablesSection, { auth, graphql, sync: services.tables, setStatus });

  root.replaceChildren(
    h('header', {}, [h('h1', {}, ['Tapestry']), account]),
    status,
    h('section', { className: 'builder' }, [
      h('h2', {}, ['Formula builder']),
      h('label', { for: 'attribute' }, [h('span', { className: 'step' }, ['1']), 'Attribute']),
      attributeInput,
      attributePicked,
      attributeResults,
      h('label', { for: 'entity' }, [h('span', { className: 'step' }, ['2']), 'Record']),
      entityInput,
      entityPicked,
      entityResults,
      h('label', { for: 'asof' }, [h('span', { className: 'step' }, ['3']), 'As of ', h('span', { className: 'optional' }, ['optional'])]),
      h('div', { className: 'asof-row' }, [asOfInput, asOfPicker]),
      h('div', { className: 'preview' }, [formulaPreview, valuePreview]),
      h('div', { className: 'actions' }, [insertButton, clearButton]),
    ]),
    selectionNote,
    overrides,
    ...(services.tables ? [tablesSection] : []),
    h('section', { className: 'workbook' }, [
      refreshButton,
      h('p', { className: 'help' }, [
        'Write ', h('code', {}, ['=TAP("NAV", "FUND-1")']), ' or ', h('code', {}, ['=TAP("NAV", "Apex Fund", DATE(2026,9,30))']),
        '. Attribute is a code, alias or name. Record is a code or name. As of is a date, a date cell, or blank for today. A date comes back as text, YYYY-MM-DD.',
      ]),
    ]),
  );

  renderAccount();
  auth.onChange(() => {
    renderAccount();
    updatePreview();
  });
  updatePreview();
  void hasShortName().then((present) => {
    useShortName = present;
    updatePreview();
  });
  void onSelectionChanged(() => { void checkSelection(); });
  void checkSelection();
}
