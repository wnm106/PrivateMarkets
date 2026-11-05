'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { attributeText } from '@/lib/experience';
import { useTemporalStore } from '@/lib/store';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import {
  gridSections,
  headlineAttributes,
  linesForSection,
  periodEndValue,
  projectStatementBook,
  readStatementAmounts,
  statementAttributesFromRegister,
  type RegisterAttribute,
  type RegisterSection,
  type StatementAttribute,
  type StatementColumn,
  type StatementPeriod,
} from '@tapestrai/graphql/src/lib/statement-book';

interface Rel {
  childEntityId: string;
  relationshipCode: string;
}

interface Node {
  id: string;
  entityName: string;
  attributes: Record<string, unknown>;
  childRelationships: Rel[];
}

const BOOK = `
  query StatementBook($asOfDate: Date, $knowledgeDate: DateTime) {
    periods: entities(filter: { domainCode: "STATEMENT_PERIOD", isActive: true }, pagination: { first: 800 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId relationshipCode } } }
    }
    attributeRegister(domainCode: "STATEMENT_PERIOD") {
      attributeCode
      attributeName
      dataType
      displaySection
      displayGroup
      isVisible
      derivationFormula
      derivationDependencies
      displayFormat
      validationRules
    }
    attributeSections(domainCode: "STATEMENT_PERIOD") {
      sectionName
      displayOrder
    }
  }
`;

function text(raw: unknown): string {
  return attributeText(raw).trim();
}

function amountOf(raw: unknown): number {
  const value = Number(text(raw).replace(/[$,]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

function money(value: number | null, blankZero = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const scaled = value / 1_000_000;
  if (blankZero && Math.abs(scaled) < 0.05) return '—';
  const body = Math.abs(scaled).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return scaled < 0 ? `(${body})` : body;
}

function percent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function millions(value: number): string {
  const scaled = value / 1_000_000;
  return `$${scaled.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
}

function longDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function shortDay(iso: string): string {
  const [year, month] = iso.slice(0, 10).split('-').map(Number);
  const name = new Date(Date.UTC(year || 1970, (month || 1) - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${name} ${year}`;
}

function formatAmount(attr: StatementAttribute, value: number | null): string {
  if (attr.role === 'section') return '';
  if (value == null || !Number.isFinite(value)) return '—';
  const signed = value * attr.sign;
  if (attr.displayFormat === 'multiple') return `${signed.toFixed(1)}x`;
  if (attr.displayFormat === 'ratio' || attr.dataType === 'PERCENTAGE') return percent(signed);
  return money(signed, attr.blankZero);
}

function formatHeadline(attr: StatementAttribute, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (attr.displayFormat === 'multiple') return `${(value * attr.sign).toFixed(1)}x`;
  if (attr.displayFormat === 'ratio' || attr.dataType === 'PERCENTAGE') return percent(value * attr.sign);
  return millions(value * attr.sign);
}

function formatCaption(attr: StatementAttribute, column: StatementColumn, byCode: Map<string, StatementAttribute>): string {
  if (attr.captionDate) {
    const body = attr.captionDate === 'long' ? longDay(column.end) : shortDay(column.end);
    return `${attr.captionPrefix}${body}${attr.captionSuffix}`;
  }
  if (!attr.captionCode) return attr.captionPrefix || attr.captionSuffix ? `${attr.captionPrefix}${attr.captionSuffix}` : '';
  const target = byCode.get(attr.captionCode);
  const value = column.values[attr.captionCode];
  if (!target || value == null || !Number.isFinite(value)) return '—';
  const body = target.displayFormat === 'multiple'
    ? `${value.toFixed(1)}x`
    : target.displayFormat === 'ratio' || target.dataType === 'PERCENTAGE'
      ? percent(value)
      : millions(value);
  return `${attr.captionPrefix}${body}${attr.captionSuffix}`;
}

function rowClass(attr: StatementAttribute): string {
  const kind = attr.role === 'section' ? 'band' : attr.role === 'line' || attr.role === 'ratio' ? '' : attr.role;
  return [kind, attr.indent ? 'indent' : '', attr.role === 'ratio' ? 'ratio' : ''].filter(Boolean).join(' ');
}

const GRAIN_NOTE = {
  quarter: 'The first column is the twelve months through the latest actual quarter.',
  month: 'Monthly flows divide each quarter into three. Balances stay at the quarter end.',
  statement: 'Twelve months through the latest actual quarter.',
} as const;

export function DealFinancials({
  borrowerId,
  borrowerName,
}: {
  borrowerId?: string | null;
  borrowerName?: string | null;
}) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [periods, setPeriods] = useState<StatementPeriod[]>([]);
  const [attributes, setAttributes] = useState<StatementAttribute[]>([]);
  const [sections, setSections] = useState<RegisterSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grain, setGrain] = useState<'quarter' | 'month' | 'statement'>('quarter');
  const [section, setSection] = useState('all');
  const inspect = useAttributeInspect();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{
      periods: { edges: Array<{ node: Node }> };
      attributeRegister: RegisterAttribute[];
      attributeSections: RegisterSection[];
    }, {
      asOfDate?: string | null;
      knowledgeDate?: string | null;
    }>(BOOK, { asOfDate, knowledgeDate }, 'network-only');
    if (result.error?.message) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    const catalog = statementAttributesFromRegister(result.data?.attributeRegister || []);
    const next = (result.data?.periods.edges || [])
      .map((edge) => edge.node)
      .filter((node) => !borrowerId || node.childRelationships.some((rel) => rel.relationshipCode === 'STATEMENT_ISSUER' && rel.childEntityId === borrowerId))
      .map((node): StatementPeriod | null => {
        const end = periodEndValue(catalog, node.attributes, text);
        if (!end) return null;
        return {
          end,
          values: readStatementAmounts(catalog, node.attributes, amountOf),
          entityId: node.id,
          entityName: node.entityName || shortDay(end),
        };
      })
      .filter((period): period is StatementPeriod => period != null);
    setAttributes(catalog);
    setSections(result.data?.attributeSections || []);
    setPeriods(borrowerId ? next : []);
    setLoading(false);
  }, [asOfDate, borrowerId, knowledgeDate]);

  useEffect(() => { void load(); }, [load]);

  const book = useMemo(
    () => projectStatementBook(periods, attributes, asOfDate, grain),
    [asOfDate, attributes, grain, periods],
  );
  const shownSections = useMemo(() => gridSections(attributes, sections), [attributes, sections]);
  const openSection = section !== 'all' && shownSections.includes(section) ? section : 'all';
  const headlines = useMemo(() => headlineAttributes(attributes), [attributes]);
  const byCode = useMemo(() => new Map(attributes.map((attr) => [attr.code, attr])), [attributes]);
  const columns = grain === 'statement'
    ? (book.pinned ? [book.pinned] : [])
    : [...(book.pinned ? [book.pinned] : []), ...book.columns];
  const pinned = book.pinned;
  const labelColumn = pinned || [...columns].reverse().find((column) => column.entityId) || null;

  const openAttribute = (event: MouseEvent, attr: StatementAttribute, column: StatementColumn | null, display: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!column?.entityId) return;
    inspect.open({
      entityId: column.entityId,
      entityName: column.entityName || borrowerName || shortDay(column.end),
      attributeCode: attr.code,
      attributeName: attr.name,
      dataType: attr.dataType,
      value: display,
      domainCode: 'STATEMENT_PERIOD',
      onChanged: () => { void load(); },
    });
  };

  return (
    <div className="da da-report">
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Financials</h2>
          <p>
            {borrowerName || 'Borrower'}
            {book.firstEnd && book.lastEnd ? `: statements from ${shortDay(book.firstEnd)} to ${shortDay(book.lastEnd)}. ` : ': '}
            {pinned?.end ? `Actuals run through ${shortDay(pinned.end)}; later periods are forecast.` : 'No reported periods yet.'}
          </p>
        </div>
        {pinned && headlines.length > 0 && (
          <div className="da-ribbon" style={{ marginTop: 12 }}>
            <div className="da-facts" style={{ gridTemplateColumns: `repeat(${headlines.length}, minmax(110px, 1fr))` }}>
              {headlines.map((attr) => (
                <div
                  className="da-fact attr-inspectable"
                  key={attr.code}
                  title="Right-click to view sources"
                  onContextMenu={(event) => openAttribute(event, attr, pinned, formatHeadline(attr, pinned.values[attr.code] ?? null))}
                >
                  <span>{attr.name}</span>
                  <strong>{formatHeadline(attr, pinned.values[attr.code] ?? null)}</strong>
                  <small>{formatCaption(attr, pinned, byCode) || shortDay(pinned.end)}</small>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {(error || book.error) && <div className="xp-error">{error || book.error}</div>}
      {loading && <div className="xp-empty">Loading financials…</div>}
      {!loading && !borrowerId && <div className="xp-empty">This deal has no borrower, so there are no financials.</div>}
      {!loading && borrowerId && periods.length === 0 && <div className="xp-empty">No quarterly statements for this borrower.</div>}

      {columns.length > 0 && shownSections.length > 0 && (
        <>
          <div className="da-sechead">
            <div className="da-tabs" role="tablist" aria-label="Period" style={{ margin: 0 }}>
              {([['quarter', 'Quarterly'], ['month', 'Monthly'], ['statement', 'Statement']] as const).map(([key, label]) => (
                <button key={key} type="button" className={grain === key ? 'on' : ''} onClick={() => setGrain(key)}>{label}</button>
              ))}
            </div>
            <div className="da-tabs" role="tablist" aria-label="Statement" style={{ margin: 0 }}>
              <button type="button" className={openSection === 'all' ? 'on' : ''} onClick={() => setSection('all')}>All</button>
              {shownSections.map((name) => (
                <button key={name} type="button" className={openSection === name ? 'on' : ''} onClick={() => setSection(name)}>{name}</button>
              ))}
            </div>
          </div>
          {shownSections.filter((name) => openSection === 'all' || name === openSection).map((name) => (
            <StatementTable
              key={name}
              title={name}
              note={GRAIN_NOTE[grain]}
              rows={linesForSection(attributes, name, grain)}
              columns={columns}
              labelColumn={labelColumn}
              onOpen={openAttribute}
            />
          ))}
        </>
      )}
    </div>
  );
}

function StatementTable({
  title,
  note,
  rows,
  columns,
  labelColumn,
  onOpen,
}: {
  title: string;
  note: string;
  rows: StatementAttribute[];
  columns: StatementColumn[];
  labelColumn: StatementColumn | null;
  onOpen: (event: MouseEvent, attr: StatementAttribute, column: StatementColumn | null, display: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const edge = columns.map((column) => column.key).join('|');
  useLayoutEffect(() => {
    const node = wrap.current;
    if (!node) return;
    const headers = [...node.querySelectorAll('thead th')];
    const label = headers[0];
    const count = headers.length - 1;
    if (!label || count === 0) return;
    const room = node.clientWidth - label.getBoundingClientRect().width;
    const minimum = 104;
    if (count * minimum <= room + 1) {
      node.style.removeProperty('--stmt-col');
      node.scrollLeft = 0;
      return;
    }
    const fit = Math.max(1, Math.floor(room / minimum));
    node.style.setProperty('--stmt-col', `${room / fit}px`);
    node.scrollLeft = node.scrollWidth;
  }, [edge]);
  if (rows.length === 0) return null;
  return (
    <section className="da-sec da-stmt">
      <div className="da-sechead">
        <h2>{title}</h2>
        <p>{note}</p>
      </div>
      <div className="da-gridwrap" ref={wrap}>
        <table className="da-grid da-roll">
          <colgroup>
            <col className="da-roll-label" />
            {columns.map((column) => <col key={column.key} />)}
          </colgroup>
          <thead>
            <tr>
              <th>$ millions</th>
              {columns.map((column) => (
                <th key={column.key} className={`num${column.pinned ? ' sum' : ''}${column.forecastStart ? ' cut' : ''}${column.actual ? ' actual' : ''}`}>
                  {column.label}
                  <span>{column.pinned ? shortDay(column.end) : column.sublabel}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code} className={rowClass(row)}>
                <td
                  className="attr-inspectable"
                  title="Right-click to view sources"
                  onContextMenu={(event) => onOpen(event, row, labelColumn, row.name)}
                >
                  {row.name}
                </td>
                {columns.map((column) => {
                  const display = formatAmount(row, column.values[row.code] ?? null);
                  return (
                    <td
                      key={column.key}
                      className={`num attr-inspectable${column.pinned ? ' sum' : ''}${column.forecastStart ? ' cut' : ''}${column.actual ? ' actual' : ''}`}
                      title="Right-click to view sources"
                      onContextMenu={(event) => onOpen(event, row, column, display)}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
