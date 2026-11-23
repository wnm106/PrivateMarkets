import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REMOTE_TOOL_EFFECTS,
  bearerChallenge,
  consentReturnHost,
  protectedResourceMetadata,
  publicOrigin,
  signInRefusal,
} from './mcp-remote';
import { isPublicPath } from './public-paths';
import { REFUSED_SIGN_IN, UNCHECKED_SIGN_IN } from './sign-in-gate';

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe('publicOrigin', () => {
  it('is the request address when nothing sits in front of the app', () => {
    assert.equal(publicOrigin(request('http://localhost:3000/api/mcp'), ''), 'http://localhost:3000');
  });

  it('is the address a proxy or tunnel was reached at', () => {
    const viaTunnel = request('http://localhost:3000/api/mcp', { 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' });
    assert.equal(publicOrigin(viaTunnel, ''), 'https://app.example.com');
    // A chain of proxies lists the outermost first.
    const chained = request('http://10.0.0.4/api/mcp', { 'x-forwarded-host': 'app.example.com, inner.local', 'x-forwarded-proto': 'https, http' });
    assert.equal(publicOrigin(chained, ''), 'https://app.example.com');
  });

  it('ignores a forwarded host or scheme that is not one', () => {
    const odd = request('http://localhost:3000/api/mcp', { 'x-forwarded-host': 'evil.example/path"', 'x-forwarded-proto': 'javascript' });
    assert.equal(publicOrigin(odd, ''), 'http://localhost:3000');
  });

  it('is the configured address when one is set', () => {
    assert.equal(publicOrigin(request('http://localhost:3000/api/mcp'), 'https://app.example.com/anything'), 'https://app.example.com');
    assert.equal(publicOrigin(request('http://localhost:3000/api/mcp'), 'not an address'), 'http://localhost:3000');
  });
});

describe('protectedResourceMetadata', () => {
  it('names the endpoint and the Supabase Auth server that signs people in for it', () => {
    assert.deepEqual(protectedResourceMetadata('https://app.example.com', 'https://abc.supabase.co/'), {
      resource: 'https://app.example.com/api/mcp',
      authorization_servers: ['https://abc.supabase.co/auth/v1'],
      bearer_methods_supported: ['header'],
      resource_name: 'tapestr.ai',
    });
  });

  it('is served where a signed-out client can read it, and the approval page is not', () => {
    assert.equal(isPublicPath('/.well-known/oauth-protected-resource'), true);
    assert.equal(isPublicPath('/.well-known/oauth-protected-resource/api/mcp'), true);
    assert.equal(isPublicPath('/oauth/consent'), false);
  });
});

describe('bearerChallenge', () => {
  it('points a client with no token at the metadata document', () => {
    assert.equal(
      bearerChallenge('https://app.example.com'),
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/api/mcp"'
    );
  });

  it('says why a token was turned away, without letting the reason break the header', () => {
    assert.equal(
      bearerChallenge('https://app.example.com', { code: 'invalid_token', description: 'The "token" has expired.' }),
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/api/mcp", error="invalid_token", error_description="The token has expired."'
    );
  });
});

describe('signInRefusal', () => {
  it('lets through a session the client rules allow', () => {
    assert.equal(signInRefusal({ allowed: true, mfa_required: false, mfa_satisfied: true }), null);
    assert.equal(signInRefusal({ allowed: true, mfa_required: true, mfa_satisfied: true }), null);
  });

  it('turns away a refused session with the reason the rules gave', () => {
    assert.equal(signInRefusal({ allowed: false, reason: 'Use Microsoft sign-in.' }), 'Use Microsoft sign-in.');
    assert.equal(signInRefusal({ allowed: false }), REFUSED_SIGN_IN);
  });

  it('turns away a session that owes a second factor', () => {
    assert.match(signInRefusal({ allowed: true, mfa_required: true, mfa_satisfied: false }) || '', /authenticator code/);
  });

  it('never lets through a check that did not run', () => {
    assert.equal(signInRefusal(null), UNCHECKED_SIGN_IN);
    assert.equal(signInRefusal({}), UNCHECKED_SIGN_IN);
  });
});

describe('what an outside assistant is offered', () => {
  it('leaves out tools that change live records', () => {
    assert.deepEqual([...REMOTE_TOOL_EFFECTS], ['read', 'stage']);
  });

  it('shows the site an approval goes back to', () => {
    assert.equal(consentReturnHost('https://claude.ai/api/mcp/auth_callback'), 'claude.ai');
    assert.equal(consentReturnHost('http://localhost:6274/oauth/callback'), 'localhost:6274');
    assert.equal(consentReturnHost('not a url'), 'not a url');
  });
});
