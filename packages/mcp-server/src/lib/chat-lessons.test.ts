import { describe, expect, it } from 'vitest';
import { formatLessons, lessonMatches, matchLessons, type Lesson } from './chat-lessons';

const exposure: Lesson = {
  phrases: ['exposure by fund and industry', 'exposure by fund by industry'],
  reading: 'One exposure amount crossed by fund and industry, with a total for each fund.',
  queryShape: '{"groupBy":["fund.entity_name","iss.INDUSTRY"]}',
  answerShape: 'groupBy Fund. Industry rows add up to the fund total.',
};

describe('chat lessons', () => {
  it('matches the phrase even when the user says by instead of and', () => {
    expect(lessonMatches('whats my total exposure by fund by industry', exposure)).toBe(true);
  });

  it('does not match a question that only names funds', () => {
    expect(lessonMatches('how many funds do I have', exposure)).toBe(false);
  });

  it('puts the reading ahead of a general example', () => {
    const text = formatLessons(matchLessons('exposure by fund and industry', [exposure]));
    expect(text).toContain('Reading:');
    expect(text).toContain('Follow these over a more general example');
  });
});
