import { describe, expect, it } from 'vitest';
import {
  normalizeReview,
  reviewNotesFor,
  reviewSummary,
  reviewSystemPrompt,
  reviewUserPrompt,
  type ReviewIssue,
} from './narrative-review';

const sections = [
  { key: 'borrowers', markdown: '**Bench Issuer 79**: Healthcare, exposure $41,044,076.12.' },
  { key: 'exec_summary', markdown: 'The portfolio has **no industry classification** on any issuer.' },
];

describe('normalizeReview', () => {
  it('keeps an issue whose quote is in the report, ignoring markdown and spacing', () => {
    const { issues, discarded } = normalizeReview({
      issues: [{
        severity: 'high', kind: 'contradiction', sections: ['exec_summary', 'borrowers'],
        quote: 'no industry classification on any issuer', problem: 'The scorecard shows industries.', suggestion: 'Reconcile.',
      }],
    }, sections);
    expect(discarded).toBe(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'high', kind: 'contradiction', sections: ['exec_summary', 'borrowers'] });
  });

  it('discards an issue whose quote is not in the report, so nothing invented is shown', () => {
    const { issues, discarded } = normalizeReview({
      issues: [{ severity: 'high', kind: 'unsupported', sections: ['borrowers'], quote: 'a sentence nobody wrote', problem: 'x' }],
    }, sections);
    expect(issues).toEqual([]);
    expect(discarded).toBe(1);
  });

  it('discards an issue that has no quote or no problem', () => {
    const { issues, discarded } = normalizeReview({ issues: [{ severity: 'high', quote: '', problem: 'x' }, { quote: 'Healthcare' }] }, sections);
    expect(issues).toEqual([]);
    expect(discarded).toBe(2);
  });

  it('finds the section from the quote when the reviewer names none or a wrong one', () => {
    const { issues } = normalizeReview({
      issues: [{ severity: 'low', kind: 'other', sections: ['nope'], quote: 'Bench Issuer 79: Healthcare', problem: 'x' }],
    }, sections);
    expect(issues[0].sections).toEqual(['borrowers']);
  });

  it('orders the most serious first and fixes an unknown severity or kind', () => {
    const { issues } = normalizeReview({
      issues: [
        { severity: 'low', kind: 'other', sections: ['borrowers'], quote: 'exposure $41,044,076.12', problem: 'a' },
        { severity: 'weird', kind: 'weird', sections: ['borrowers'], quote: 'Healthcare', problem: 'b' },
        { severity: 'high', kind: 'unsupported', sections: ['exec_summary'], quote: 'no industry classification', problem: 'c' },
      ],
    }, sections);
    expect(issues.map((i) => i.problem)).toEqual(['c', 'b', 'a']);
    expect(issues[1]).toMatchObject({ severity: 'medium', kind: 'other' });
  });

  it('accepts a bare array and tolerates garbage', () => {
    expect(normalizeReview([{ severity: 'low', sections: ['borrowers'], quote: 'Healthcare', problem: 'x' }, null, 7], sections).issues).toHaveLength(1);
    expect(normalizeReview('nonsense', sections)).toEqual({ issues: [], discarded: 0 });
    expect(normalizeReview(undefined, sections)).toEqual({ issues: [], discarded: 0 });
  });
});

describe('prompts', () => {
  it('gives the reviewer each section with its notes, findings, and untraced figures', () => {
    const prompt = reviewUserPrompt([{ key: 'a', title: 'A', markdown: 'text', notes: ['no value on any row for INDUSTRY'], findings: 'found x', untraced: ['3.52%'] }]);
    expect(prompt).toContain('Section [a]: A');
    expect(prompt).toContain('Data notes: no value on any row for INDUSTRY');
    expect(prompt).toContain('Findings: found x');
    expect(prompt).toContain('3.52%');
  });

  it('names every kind of problem to look for and demands an exact quote', () => {
    const system = reviewSystemPrompt();
    for (const kind of ['contradiction', 'gap-vs-figure', 'unsupported', 'record-mixup', 'stated-as-fact']) expect(system).toContain(kind);
    expect(system).toMatch(/exact words/);
    expect(system).toMatch(/did not write it/);
  });

  it('shortens a very long section but keeps its beginning and end', () => {
    const long = `START ${'x '.repeat(30000)} END`;
    const prompt = reviewUserPrompt([{ key: 'a', title: 'A', markdown: long, notes: [] }]);
    expect(prompt.length).toBeLessThan(15000);
    expect(prompt).toContain('START');
    expect(prompt).toContain('END');
    expect(prompt).toContain('characters omitted');
  });
});

describe('summary and fix notes', () => {
  const issues: ReviewIssue[] = [
    { severity: 'high', kind: 'record-mixup', sections: ['borrowers'], quote: 'Healthcare', problem: 'Industry came from a same-named record.', suggestion: 'Say industry is not available.' },
    { severity: 'low', kind: 'other', sections: ['exec_summary', 'borrowers'], quote: '41,044,076.12', problem: 'Rounded inconsistently.' },
  ];

  it('summarizes in one line', () => {
    expect(reviewSummary({ issues })).toBe('2 consistency issues (1 high)');
    expect(reviewSummary({ issues: [issues[1]] })).toBe('1 consistency issue');
    expect(reviewSummary({ issues: [] })).toBe('No consistency issues found');
    expect(reviewSummary(null)).toBe('No consistency issues found');
  });

  it('turns the issues for one section into notes the writer must address', () => {
    const notes = reviewNotesFor('borrowers', issues);
    expect(notes).toContain('Industry came from a same-named record.');
    expect(notes).toContain('you wrote: "Healthcare"');
    expect(notes).toContain('Do this instead: Say industry is not available.');
    expect(notes.split('\n')).toHaveLength(2);
    expect(reviewNotesFor('exec_summary', issues)).not.toContain('same-named');
    expect(reviewNotesFor('outlook', issues)).toBe('');
  });
});
