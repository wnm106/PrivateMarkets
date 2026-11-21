import { SignedOutError, type ExcelAuth } from './auth';

/**
 * GraphQL as the signed-in person. The web app's /api/graphql scopes every read to
 * the bearer token, so Row Level Security decides what each person sees.
 * Cookies are never sent: the add-in's session is its token alone.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GraphQLRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

function notAuthenticated(status: number, errors: Array<{ message?: string }> | undefined): boolean {
  return status === 401 || Boolean(errors?.some((error) => /not authenticated|jwt|invalid token/i.test(error.message || '')));
}

export class GraphQLClient {
  constructor(
    private readonly endpoint: string,
    private readonly auth: Pick<ExcelAuth, 'getAccessToken'>,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let token = await this.auth.getAccessToken();
    if (!token) throw new SignedOutError();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        throw new GraphQLRequestError('Tapestry could not be reached.');
      }
      const body = await response.json().catch(() => null) as { data?: T; errors?: Array<{ message?: string }> } | null;
      if (notAuthenticated(response.status, body?.errors)) {
        if (attempt > 0) break;
        token = await this.auth.getAccessToken(true);
        if (!token) break;
        continue;
      }
      if (!response.ok && !body?.data) throw new GraphQLRequestError(`Tapestry returned ${response.status}.`);
      if (body?.errors?.length) throw new GraphQLRequestError(body.errors.map((error) => error.message).filter(Boolean).join('; ') || 'Tapestry returned an error.');
      if (!body?.data) throw new GraphQLRequestError('Tapestry returned no data.');
      return body.data;
    }
    throw new SignedOutError('Your Tapestry sign-in has ended. Open the Tapestry pane and sign in again.');
  }
}
