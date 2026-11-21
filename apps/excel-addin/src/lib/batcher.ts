/**
 * Excel calls a custom function once per cell, often hundreds of times in one
 * recalculation. Calls made close together are sent as one request, and the same
 * request in many cells is asked once.
 */

export interface BatcherOptions<Req> {
  /** A key that is the same for two requests with the same answer. */
  key: (request: Req) => string;
  /** How long to wait for more calls before sending. */
  delayMs?: number;
  /** Most requests in one send. */
  maxBatch?: number;
}

interface Pending<Res> {
  resolve: (value: Res) => void;
  reject: (error: unknown) => void;
  promise: Promise<Res>;
}

export class Batcher<Req, Res> {
  private queue = new Map<string, { request: Req; pending: Pending<Res> }>();
  private inFlight = new Map<string, Promise<Res>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly maxBatch: number;

  constructor(
    private readonly send: (requests: Req[]) => Promise<Res[]>,
    private readonly options: BatcherOptions<Req>,
  ) {
    this.delayMs = options.delayMs ?? 40;
    this.maxBatch = Math.max(1, options.maxBatch ?? 200);
  }

  request(request: Req): Promise<Res> {
    const key = this.options.key(request);
    const flying = this.inFlight.get(key);
    if (flying) return flying;
    const queued = this.queue.get(key);
    if (queued) return queued.pending.promise;

    let resolve!: (value: Res) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Res>((res, rej) => { resolve = res; reject = rej; });
    this.queue.set(key, { request, pending: { resolve, reject, promise } });
    if (this.queue.size >= this.maxBatch) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delayMs);
    return promise;
  }

  /** Send everything queued now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.size) {
      const entries = [...this.queue.entries()].slice(0, this.maxBatch);
      for (const [key] of entries) this.queue.delete(key);
      void this.sendBatch(entries);
    }
  }

  private async sendBatch(entries: Array<[string, { request: Req; pending: Pending<Res> }]>): Promise<void> {
    for (const [key, entry] of entries) this.inFlight.set(key, entry.pending.promise);
    try {
      const results = await this.send(entries.map(([, entry]) => entry.request));
      entries.forEach(([, entry], index) => {
        if (index < results.length) entry.pending.resolve(results[index]);
        else entry.pending.reject(new Error('The server returned fewer answers than requests.'));
      });
    } catch (error) {
      for (const [, entry] of entries) entry.pending.reject(error);
    } finally {
      for (const [key] of entries) this.inFlight.delete(key);
    }
  }
}
