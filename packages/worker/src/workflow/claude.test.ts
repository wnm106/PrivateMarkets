import { describe, expect, it } from 'vitest';
import { explain } from './claude';

describe('explain', () => {
  it('says to set a key and retry when the worker has none', () => {
    const error = new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.');
    expect(explain(error).message).toBe('No Anthropic key is set where the worker runs. Set ANTHROPIC_API_KEY for the worker, then retry the run: it continues from this step.');
  });

  it('passes any other error through as it is', () => {
    const error = new Error('Something else');
    expect(explain(error)).toBe(error);
  });
});
