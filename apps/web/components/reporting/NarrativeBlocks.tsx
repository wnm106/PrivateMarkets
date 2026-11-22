'use client';

/**
 * Renders a narrative's blocks. Layout follows what the composer chose: half-width blocks sit side by
 * side, a hero states a section's answer, chart and table titles read as findings, and a block's note
 * says what to take from it. Charts and tables live in NarrativeChart and StoryTable.
 */
import { markdownToHtml } from '@/lib/markdown';
import { sanitizeHtmlLinks, type NarrativeBlock } from '@/lib/reporting';
import { sparkPath, trendColor, NEUTRAL } from '@/lib/narrative-visual';
import { NarrativeChart } from './NarrativeChart';
import { StoryTable } from './StoryTable';

const SEVERITY: Record<string, { bg: string; fg: string; label: string }> = {
  info: { bg: '#eef4fb', fg: '#1e3a5f', label: 'Info' },
  positive: { bg: '#e1f1e7', fg: '#047857', label: 'Positive' },
  warning: { bg: '#fdf3d7', fg: '#a16207', label: 'Watch' },
  critical: { bg: '#fdecec', fg: '#b91c1c', label: 'Critical' },
  high: { bg: '#fdecec', fg: '#b91c1c', label: 'High' },
  medium: { bg: '#fdf3d7', fg: '#a16207', label: 'Medium' },
  low: { bg: '#eef4fb', fg: '#1e3a5f', label: 'Low' },
};

const TONE_BAR: Record<string, string> = {
  positive: '#047857', warning: '#b45309', critical: '#b91c1c', info: '#2a78d6', neutral: '#1e3a5f',
};

/** Blocks whose title states a finding (a headline), as opposed to a label over a list. */
const HEADLINE_TITLES = new Set(['chart', 'table', 'scorecard']);

type Row = { half: boolean; blocks: NarrativeBlock[] };

/** Consecutive half-width blocks share a row; everything else gets a row of its own. */
export function layoutRows(blocks: NarrativeBlock[]): Row[] {
  const rows: Row[] = [];
  for (const b of blocks) {
    const half = b.width === 'half';
    const last = rows[rows.length - 1];
    if (half && last?.half && last.blocks.length < 2) last.blocks.push(b);
    else rows.push({ half, blocks: [b] });
  }
  return rows;
}

export function NarrativeBlocks({ blocks }: { blocks: NarrativeBlock[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      {layoutRows(blocks).map((row, ri) => (row.half && row.blocks.length > 1 ? (
        // min(300px, 100%): a narrow container stacks the pair instead of being pushed wider than it is.
        <div key={ri} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '22px', alignItems: 'start' }}>
          {row.blocks.map((b, i) => <Block key={`${b.key}-${i}`} block={b} />)}
        </div>
      ) : (
        <Block key={`${row.blocks[0].key}-${ri}`} block={row.blocks[0]} />
      )))}
    </div>
  );
}

function Block({ block }: { block: NarrativeBlock }) {
  const headline = HEADLINE_TITLES.has(block.type);
  return (
    <section style={{ minWidth: 0 }}>
      {block.title && block.type !== 'hero' && (
        <div style={headline
          ? { fontSize: '14px', fontWeight: 600, color: 'var(--ink)', marginBottom: '10px', lineHeight: 1.35 }
          : { fontSize: '11px', fontWeight: 600, color: 'var(--ink-3)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {block.title}
        </div>
      )}
      <BlockBody block={block} />
      {block.note && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          {block.note}
        </div>
      )}
    </section>
  );
}

function Spark({ values, width = 96, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const p = sparkPath(values, width, height);
  if (!p) return null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block', marginTop: 6 }}>
      <path d={p.d} fill="none" stroke={NEUTRAL} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={p.last.x} cy={p.last.y} r={3} fill="#2a78d6" />
    </svg>
  );
}

const ARROW: Record<string, string> = { up: '▲', down: '▼', flat: '▬' };

function BlockBody({ block }: { block: NarrativeBlock }) {
  switch (block.type) {
    case 'markdown':
      return (
        <div
          className="markdown-content"
          style={{ fontSize: '14px', lineHeight: 1.65, color: 'var(--ink-2)' }}
          // markdownToHtml escapes HTML first; links are additionally restricted to safe schemes.
          dangerouslySetInnerHTML={{ __html: sanitizeHtmlLinks(markdownToHtml(block.text)) }}
        />
      );
    case 'hero': {
      const bar = TONE_BAR[block.tone ?? 'neutral'] ?? TONE_BAR.neutral;
      return (
        <div style={{ borderLeft: `4px solid ${bar}`, padding: '6px 0 6px 18px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {block.title ?? block.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', flexWrap: 'wrap', marginTop: '2px' }}>
            <span style={{ fontSize: '48px', fontWeight: 600, lineHeight: 1.1, color: 'var(--ink)' }}>{block.value}</span>
            {block.delta && (
              <span style={{ fontSize: '14px', fontWeight: 600, color: trendColor(block.trend, block.good) }}>
                {block.trend && <span style={{ fontSize: '11px', marginRight: 4 }}>{ARROW[block.trend]}</span>}
                {block.delta}
              </span>
            )}
          </div>
          {block.title && block.label && <div style={{ fontSize: '13px', color: 'var(--ink-3)', marginTop: '2px' }}>{block.label}</div>}
          {block.text && <div style={{ fontSize: '15px', lineHeight: 1.55, color: 'var(--ink-2)', marginTop: '10px', maxWidth: 720 }}>{block.text}</div>}
        </div>
      );
    }
    case 'table':
    case 'scorecard':
      return <StoryTable block={block} />;
    case 'chart':
      return <NarrativeChart block={block} />;
    case 'kpis':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: '10px' }}>
          {block.items.map((item, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '12px 14px', background: 'white' }}>
              <div style={{ fontSize: '11px', color: 'var(--ink-3)', fontWeight: 500 }}>{item.label}</div>
              <div
                style={/^data not available/i.test(item.value)
                  ? { fontSize: '13px', fontWeight: 500, margin: '6px 0', color: 'var(--ink-3)' }
                  : { fontSize: '24px', fontWeight: 600, margin: '2px 0', color: 'var(--ink)' }}
              >
                {item.value}
                {item.trend && (
                  <span style={{ fontSize: '11px', marginLeft: '6px', color: trendColor(item.trend, item.good) }}>{ARROW[item.trend]}</span>
                )}
              </div>
              {item.detail && <div style={{ fontSize: '11px', color: 'var(--ink-3)', lineHeight: 1.4 }}>{item.detail}</div>}
              {item.spark && <Spark values={item.spark} />}
            </div>
          ))}
        </div>
      );
    case 'callouts':
      return (
        <div style={{ display: 'grid', gap: '10px' }}>
          {block.items.map((item, i) => {
            const s = SEVERITY[item.severity] || SEVERITY.info;
            return (
              <div key={i} style={{ borderLeft: `3px solid ${s.fg}`, background: s.bg, padding: '10px 14px', borderRadius: '0 6px 6px 0' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: s.fg }}>{s.label}</div>
                <div style={{ fontWeight: 600, fontSize: '14px', margin: '2px 0 6px', color: 'var(--ink)' }}>{item.title}</div>
                {item.fields.map((field, j) => (
                  <div key={j} style={{ fontSize: '13px', color: 'var(--ink-2)', margin: '3px 0', lineHeight: 1.5 }}>
                    <strong>{field.label}:</strong> {field.value}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      );
    case 'sources':
      return (
        <ol style={{ fontSize: '12px', color: 'var(--ink-2)', paddingLeft: '18px', margin: 0 }}>
          {block.items.map((item, i) => (
            <li key={i} style={{ margin: '3px 0' }}>
              {item.url ? <a href={item.url} target="_blank" rel="noreferrer noopener" className="crumb-link">{item.title}</a> : item.title}
              {item.publisher ? `, ${item.publisher}` : ''}{item.date ? ` (${item.date})` : ''}
              {item.note ? ` - ${item.note}` : ''}
            </li>
          ))}
        </ol>
      );
    case 'insights':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '10px' }}>
          {block.items.map((it, i) => {
            const s = SEVERITY[it.severity] || SEVERITY.info;
            return (
              <div key={i} style={{ borderLeft: `3px solid ${s.fg}`, background: s.bg, padding: '10px 14px', borderRadius: '0 6px 6px 0' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: s.fg }}>{s.label}</div>
                <div style={{ fontWeight: 600, fontSize: '13px', margin: '2px 0', color: 'var(--ink)' }}>{it.title}</div>
                <div style={{ fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.5 }}>{it.detail}</div>
              </div>
            );
          })}
        </div>
      );
  }
}
