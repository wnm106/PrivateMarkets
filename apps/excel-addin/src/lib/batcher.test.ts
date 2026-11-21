import { describe, expect, it } from 'vitest';
import { Batcher } from './batcher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('Batcher', () => {
  it('sends calls made together as one request, and the same call once', async () => {
    const sent: string[][] = [];
    const batcher = new Batcher<string, string>(async (requests) => {
      sent.push(requests);
      return requests.map((request) => request.toUpperCase());
    }, { key: (request) => request.toLowerCase(), delayMs: 5 });
    const answers = await Promise.all(['a', 'b', 'A', 'c'].map((request) => batcher.request(request)));
    expect(answers).toEqual(['A', 'B', 'A', 'C']);
    expect(sent).toEqual([['a', 'b', 'c']]);
  });

  it('splits at the batch limit', async () => {
    const sizes: number[] = [];
    const batcher = new Batcher<number, number>(async (requests) => {
      sizes.push(requests.length);
      return requests;
    }, { key: String, maxBatch: 2, delayMs: 5 });
    await Promise.all([1, 2, 3, 4, 5].map((request) => batcher.request(request)));
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('shares an answer that is already on its way', async () => {
    const reply = deferred<string[]>();
    let sends = 0;
    const batcher = new Batcher<string, string>(() => { sends += 1; return reply.promise; }, { key: String, delayMs: 1 });
    const first = batcher.request('x');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = batcher.request('x');
    reply.resolve(['done']);
    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(sends).toBe(1);
  });

  it('fails every call in a batch that fails, and asks again next time', async () => {
    let calls = 0;
    const batcher = new Batcher<string, string>(async (requests) => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return requests;
    }, { key: String, delayMs: 1 });
    await expect(Promise.all([batcher.request('a'), batcher.request('b')])).rejects.toThrow('offline');
    expect(await batcher.request('a')).toBe('a');
  });
});
