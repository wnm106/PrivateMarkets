import { describe, expect, it } from 'vitest';
import { JOB_TYPES, jobScheduleProblem, jobType } from './job-types';

describe('assistant job types', () => {
  it('lets a client schedule the sweep and keeps the brief off the schedule form', () => {
    expect(jobType('assistant.sweep')?.schedulable).toBeUndefined();
    expect(jobScheduleProblem('assistant.sweep', 'client-a')).toBeNull();
    expect(jobScheduleProblem('assistant.brief', 'client-a')).toMatch(/not put on a schedule/);
    expect(jobScheduleProblem('assistant.watch', null)).toMatch(/needs a client/);
    expect(JOB_TYPES.filter((type) => type.schedulable === false).map((type) => type.code)).toEqual(['assistant.brief', 'assistant.watch', 'notify.deliver', 'email.screen', 'document.process', 'workflow.advance']);
  });
});
