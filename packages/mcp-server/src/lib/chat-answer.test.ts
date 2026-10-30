import { describe, expect, it } from 'vitest';
import { nestTable, parseChatAnswer, presentAnswer } from './chat-answer';

const message = `Here is the exposure.

\`\`\`answer
{
  "lead": "Total portfolio exposure is $15.65 billion across 6,203 positions.",
  "kpis": [{ "label": "Exposure", "value": "$15.65B", "detail": "6,203 positions" }],
  "meters": {
    "title": "Exposure by fund",
    "format": "currency",
    "items": [
      { "label": "Bench Fund 4", "value": 1164560000, "detail": "463 positions" },
      { "label": "Skip", "value": "nope" }
    ]
  },
  "table": {
    "title": "By fund",
    "columns": ["Fund", "Exposure", "Share"],
    "rows": [["Bench Fund 4", 1164560000, 0.0745]]
  }
}
\`\`\``;

describe('parseChatAnswer', () => {
  it('keeps the lead, the figures, and the grid, and drops the fence from the prose', () => {
    const answer = parseChatAnswer(message);
    expect(answer?.lead).toContain('$15.65 billion');
    expect(answer?.prose).toBe('Here is the exposure.');
    expect(answer?.kpis).toEqual([{ label: 'Exposure', value: '$15.65B', detail: '6,203 positions' }]);
    expect(answer?.meters[0].items).toEqual([
      { label: 'Bench Fund 4', value: 1164560000, detail: '463 positions' },
    ]);
    expect(answer?.tables[0].rows).toEqual([['Bench Fund 4', 1164560000, 0.0745]]);
  });

  it('nests industry exposure under each fund total', () => {
    const nested = nestTable({
      groupBy: 'Fund',
      columns: ['Fund', 'Industry', 'Exposure', 'Share of fund'],
      rows: [
        ['Bench Fund 20', 'Energy', 200, 0.4],
        ['Bench Fund 4', 'Unclassified', 700, 0.7],
        ['Bench Fund 20', 'Software', 300, 0.6],
        ['Bench Fund 4', 'Software', 300, 0.3],
      ],
    });
    expect(nested?.groups.map((group) => [group.label, group.total])).toEqual([
      ['Bench Fund 4', 1000],
      ['Bench Fund 20', 500],
    ]);
    expect(nested?.groups[0].rows.map((row) => row[1])).toEqual(['Unclassified', 'Software']);
  });

  it('presents a fenced answer as tables instead of the raw block', () => {
    const shown = presentAnswer(`\`\`\`answer
{"lead":"Total exposure is $15.65 billion.","kpis":[{"label":"Exposure","value":"$15.65B","detail":"6,216 positions"}],"tables":[{"title":"Exposure by fund and industry","groupBy":"Fund","columns":["Fund","Industry","Exposure","Share of fund"],"rows":[["Bench Fund 4","Unclassified",1164561112.67,1]]}]}
\`\`\``);
    expect(shown).not.toContain('```');
    expect(shown).toContain('Total exposure is $15.65 billion.');
    expect(shown).toContain('Bench Fund 4');
    expect(shown).toContain('Unclassified');
    expect(shown).toContain('| Industry |');
  });

  it('leaves an ordinary reply alone', () => {
    expect(parseChatAnswer('There are 22 funds.')).toBeNull();
  });

  it('leaves a broken block in the prose', () => {
    expect(parseChatAnswer('```answer\n{not json}\n```')).toBeNull();
  });
});
