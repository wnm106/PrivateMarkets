/**
 * A lesson is a phrase the business uses, and how to read, query, and answer it.
 * Matching lessons are added to the prompt for that question. They are not
 * remembered from the chat transcript alone.
 */

const STOP = new Set([
  'a', 'an', 'the', 'by', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'my', 'our',
  'with', 'within', 'per', 'vs', 'versus', 'what', 'whats', 'show', 'me', 'total',
]);

export interface Lesson {
  id?: string;
  phrases: string[];
  reading: string;
  queryShape: string;
  answerShape: string;
}

export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

export function lessonMatches(userText: string, lesson: Lesson): boolean {
  const raw = userText.toLowerCase();
  const words = new Set(contentWords(userText));
  return lesson.phrases.some((phrase) => {
    const normalized = phrase.toLowerCase().trim();
    if (normalized.length > 3 && raw.includes(normalized)) return true;
    const needed = contentWords(phrase);
    if (needed.length < 2) return false;
    return needed.every((word) => words.has(word));
  });
}

export function matchLessons(userText: string, lessons: Lesson[], limit = 3): Lesson[] {
  return lessons.filter((lesson) => lessonMatches(userText, lesson)).slice(0, limit);
}

export function lessonFromRow(row: {
  id?: string;
  phrases?: string[] | null;
  reading?: string | null;
  query_shape?: string | null;
  answer_shape?: string | null;
}): Lesson {
  return {
    id: row.id,
    phrases: Array.isArray(row.phrases) ? row.phrases : [],
    reading: row.reading || '',
    queryShape: row.query_shape || '',
    answerShape: row.answer_shape || '',
  };
}

/** Standing instructions for a question. A matched lesson overrides a general example. */
export function formatLessons(lessons: Lesson[]): string {
  if (!lessons.length) return '';
  const blocks = lessons.map((lesson) => [
    `Phrase: ${lesson.phrases.join(' | ')}`,
    `Reading: ${lesson.reading}`,
    `Query: ${lesson.queryShape}`,
    `Answer: ${lesson.answerShape}`,
  ].join('\n'));
  return `\n\n## Lessons that match this question\nFollow these over a more general example. The reading says what the phrase means. The query is the shape to run. The answer is how to present it.\n\n${blocks.join('\n\n')}\n`;
}
