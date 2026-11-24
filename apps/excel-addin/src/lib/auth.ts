import type { ExcelSession } from '@tapestrai/graphql/src/lib/excel-session';

/**
 * The signed-in person's Excel session (docs/EXCEL_ADDIN.md).
 *
 * The add-in is the only holder of this session: the sign-in page forgets it once
 * it is sent here. The add-in refreshes it with Supabase Auth directly. Every read
 * goes to storage rather than memory, so two open workbooks share one session and
 * see each other's refreshes.
 */

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const SESSION_KEY = 'tapestry.excel.session';

/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;

export class SignedOutError extends Error {
  constructor(message = 'Sign in to Tapestry: open the Tapestry pane and choose Sign in.') {
    super(message);
    this.name = 'SignedOutError';
  }
}

/**
 * localStorage, or null when this page may not use it. In Excel on the web the pane is a
 * third-party frame, and a browser that blocks third-party cookies throws on the mere
 * read of window.localStorage. That must never stop the add-in from starting.
 */
export function pageStorage(): Storage | null {
  try {
    const storage = typeof window === 'undefined' ? undefined : window.localStorage;
    if (!storage) return null;
    const probe = '__tapestry_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * A key-value store over localStorage that falls back to memory. Without storage the
 * sign-in lasts while the workbook is open; `persistent` says which one this is.
 */
export function browserStore(storage: Storage | null | undefined = pageStorage()): KeyValueStore & { persistent: boolean } {
  const memory = new Map<string, string>();
  return {
    persistent: Boolean(storage),
    get(key) {
      try { return storage ? storage.getItem(key) : memory.get(key) ?? null; } catch { return memory.get(key) ?? null; }
    },
    set(key, value) {
      memory.set(key, value);
      try { storage?.setItem(key, value); } catch { /* memory only */ }
    },
    remove(key) {
      memory.delete(key);
      try { storage?.removeItem(key); } catch { /* memory only */ }
    },
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ExcelAuth {
  private refreshing: Promise<string | null> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  session(): ExcelSession | null {
    const raw = this.store.get(SESSION_KEY);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as ExcelSession;
      return session?.refreshToken && session?.supabaseUrl ? session : null;
    } catch {
      return null;
    }
  }

  email(): string | null {
    return this.session()?.email || null;
  }

  /** The client this sign-in works in, when the person chose one at sign-in. */
  clientName(): string | null {
    return this.session()?.clientName || null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Another workbook's add-in changed the session. */
  notifyExternalChange(): void {
    this.emit();
  }

  accept(session: ExcelSession): void {
    this.save(session);
    this.emit();
  }

  /** A token that is good for at least another minute, or null when signed out. */
  async getAccessToken(forceRefresh = false): Promise<string | null> {
    const session = this.session();
    if (!session) return null;
    if (!forceRefresh && session.expiresAt * 1000 - this.now() > REFRESH_EARLY_MS) return session.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh(session, forceRefresh).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async refresh(seen: ExcelSession, forced: boolean): Promise<string | null> {
    // Another workbook may have refreshed already.
    const current = this.session();
    if (!current) return null;
    if (current.refreshToken !== seen.refreshToken && current.expiresAt * 1000 - this.now() > REFRESH_EARLY_MS) {
      return current.accessToken;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${current.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: current.anonKey, Authorization: `Bearer ${current.anonKey}` },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
        credentials: 'omit',
      });
    } catch {
      // Offline: keep the session. A token that has not expired yet still works.
      if (!forced && current.expiresAt * 1000 > this.now()) return current.accessToken;
      throw new Error('Tapestry could not be reached.');
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // The refresh token was revoked or has expired, or the organization's rules refuse it.
      this.clear();
      return null;
    }
    if (!response.ok) {
      if (!forced && current.expiresAt * 1000 > this.now()) return current.accessToken;
      throw new Error(`Tapestry sign-in could not be refreshed (${response.status}).`);
    }
    const body = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      expires_in?: number;
      user?: { id?: string; email?: string };
    };
    if (!body.access_token || !body.refresh_token) {
      this.clear();
      return null;
    }
    this.save({
      ...current,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at ?? Math.floor(this.now() / 1000) + (body.expires_in || 3600),
      email: body.user?.email || current.email,
      userId: body.user?.id || current.userId,
    });
    return body.access_token;
  }

  /** Revoke this Excel session (not the person's other sessions) and forget it. */
  async signOut(): Promise<void> {
    const session = this.session();
    if (session) {
      try {
        await this.fetchImpl(`${session.supabaseUrl}/auth/v1/logout?scope=local`, {
          method: 'POST',
          headers: { apikey: session.anonKey, Authorization: `Bearer ${session.accessToken}` },
          credentials: 'omit',
        });
      } catch {
        /* Forget it here even if Tapestry cannot be reached. */
      }
    }
    this.clear();
  }

  private save(session: ExcelSession): void {
    this.store.set(SESSION_KEY, JSON.stringify(session));
  }

  private clear(): void {
    const had = this.store.get(SESSION_KEY) !== null;
    this.store.remove(SESSION_KEY);
    if (had) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a listener must not break auth */ }
    }
  }
}
