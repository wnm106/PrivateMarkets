'use client';

import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { NarrativeBlocks } from '@/components/reporting/NarrativeBlocks';
import { markdownToHtml } from '@/lib/markdown';
import { nestTable, type ChatAnswer as ChatAnswerModel, type ChatTable } from '@tapestrai/mcp-server/src/lib/chat-answer';

function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatMeter(value: number, format: 'currency' | 'number' | 'percent'): string {
  if (format === 'percent') return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
  if (format === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return money(value);
}

function columnKind(name: string): 'currency' | 'percent' | 'number' | 'text' {
  const header = name.toLowerCase();
  if (/share|weight|percent|var %|pct/.test(header)) return 'percent';
  if (/exposure|value|amount|nav|market|commitment|contribution|distribution|asset|liabilit/.test(header)) return 'currency';
  return 'text';
}

function formatCell(value: unknown, kind: 'currency' | 'percent' | 'number' | 'text'): string {
  if (value == null || value === '') return '';
  if (typeof value !== 'number') return String(value);
  if (kind === 'percent') return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
  if (kind === 'currency') return money(value);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function shareOfGroup(value: unknown, column: string, rowExposure: unknown, fundTotal: number | null): string {
  if (/share|weight|percent|pct/i.test(column) && fundTotal && typeof rowExposure === 'number' && fundTotal !== 0) {
    return `${((rowExposure / fundTotal) * 100).toFixed(1)}%`;
  }
  return formatCell(value, columnKind(column) === 'text' && typeof value === 'number' ? 'number' : columnKind(column));
}

function GroupedTable({ table }: { table: ChatTable }) {
  const nested = nestTable(table);
  if (!nested) return <AnswerTable table={table} />;
  const detailColumns = table.columns
    .map((name, index) => ({ name, index }))
    .filter((column) => column.index !== nested.groupIndex);
  return (
    <div className="chat-groups">
      {nested.groups.map((group) => (
        <section key={group.label} className="chat-group">
          <div className="chat-group-head">
            <span>{group.label}</span>
            {group.total != null && <span>{money(group.total)}</span>}
          </div>
          <table className="chat-answer-table">
            <thead>
              <tr>{detailColumns.map((column) => <th key={column.name}>{column.name}</th>)}</tr>
            </thead>
            <tbody>
              {group.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {detailColumns.map((column) => (
                    <td key={column.name} className={typeof row[column.index] === 'number' ? 'num' : undefined}>
                      {shareOfGroup(row[column.index], column.name, nested.valueIndex >= 0 ? row[nested.valueIndex] : null, group.total)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function AnswerTable({ table }: { table: ChatTable }) {
  const kinds = table.columns.map((column, index) => {
    const named = columnKind(column);
    if (named !== 'text') return named;
    const numbers = table.rows.map((row) => row[index]).filter((value) => typeof value === 'number');
    return numbers.length && numbers.length === table.rows.filter((row) => row[index] != null && row[index] !== '').length
      ? 'number' as const
      : 'text' as const;
  });
  const columns: ColDef[] = table.columns.map((name, index) => ({
    colId: `c${index}`,
    headerName: name,
    flex: 1,
    minWidth: index === 0 ? 140 : 110,
    type: kinds[index] === 'text' ? undefined : 'rightAligned',
    valueGetter: (params) => params.data?.[`c${index}`],
    valueFormatter: (params) => formatCell(params.value, kinds[index]),
  }));
  const rows = table.rows.map((row, index) => {
    const record: Record<string, unknown> = { __id: String(index) };
    row.forEach((value, cellIndex) => { record[`c${cellIndex}`] = value; });
    return record;
  });
  return (
    <div className="chat-answer-grid">
      <AppGrid
        rows={rows}
        columns={columns}
        getRowId={(row) => String(row.__id)}
        autoHeight={false}
        height={Math.min(360, 42 + rows.length * 36)}
        rowGroupPanelShow="never"
        emptyMessage="No rows"
      />
    </div>
  );
}

function MeterGroup({ group }: { group: ChatAnswerModel['meters'][number] }) {
  const meterMax = Math.max(...group.items.map((item) => Math.abs(item.value)), 1);
  return (
    <div className="chat-meters">
      {group.title && <div className="chat-answer-kicker">{group.title}</div>}
      {group.items.map((item) => (
        <div key={item.label} className="chat-meter">
          <div className="chat-meter-top">
            <span>{item.label}</span>
            <span>{formatMeter(item.value, group.format)}{item.detail ? ` · ${item.detail}` : ''}</span>
          </div>
          <div className="chat-meter-track">
            <div className="chat-meter-fill" style={{ width: `${Math.min(100, (Math.abs(item.value) / meterMax) * 100)}%` }} />
            {item.marker != null && (
              <div className="chat-meter-marker" style={{ left: `${Math.min(100, (Math.abs(item.marker) / meterMax) * 100)}%` }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatAnswerView({ answer }: { answer: ChatAnswerModel }) {
  return (
    <div className="chat-answer">
      {answer.prose && (
        <div className="markdown-content" dangerouslySetInnerHTML={{ __html: markdownToHtml(answer.prose) }} />
      )}
      {answer.lead && <p className="chat-answer-lead">{answer.lead}</p>}
      {answer.kpis.length > 0 && (
        <div className="chat-kpis">
          {answer.kpis.map((kpi) => (
            <div key={kpi.label} className="chat-kpi">
              <div className="chat-kpi-label">{kpi.label}</div>
              <div className="chat-kpi-value">{kpi.value}</div>
              {kpi.detail && <div className="chat-kpi-detail">{kpi.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {answer.meters.map((group) => <MeterGroup key={group.title || group.items[0]?.label} group={group} />)}
      {answer.chart && (
        <NarrativeBlocks blocks={[{ type: 'chart', key: 'chart', title: answer.chart.title, chartType: answer.chart.chartType, labels: answer.chart.labels, series: answer.chart.series }]} />
      )}
      {answer.tables.map((table) => (
        <div key={table.title || table.columns.join()}>
          {table.title && <div className="chat-answer-kicker">{table.title}</div>}
          {table.groupBy ? <GroupedTable table={table} /> : <AnswerTable table={table} />}
        </div>
      ))}
    </div>
  );
}
