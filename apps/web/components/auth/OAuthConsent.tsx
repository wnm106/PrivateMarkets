'use client';

import { useEffect, useState } from 'react';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { consentReturnHost } from '@/lib/mcp-remote';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

/**
 * Where an outside assistant (a claude.ai connector) sends a person to approve
 * its connection. The Supabase Auth server runs the sign-in flow and sends the
 * browser here with the id of the request; this page shows who is asking and
 * records the answer. See docs/API.md, "Remote MCP endpoint".
 *
 * The person is already signed in to the app when this renders: middleware
 * sends a signed-out visitor to the sign-in page first, and brings them back.
 */

type Step =
  | { kind: 'loading' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'confirm'; id: string; clientName: string; returnsTo: string; email: string }
  | { kind: 'leaving' };

const NOT_VALID = 'This connection request is not valid or has expired. Start again from the app you are connecting.';

export function OAuthConsent() {
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Read the live URL: the rendered search params can be empty on the first client pass.
      const id = new URLSearchParams(window.location.search).get('authorization_id');
      if (!id) {
        setStep({ kind: 'invalid', reason: NOT_VALID });
        return;
      }
      const { data, error: failure } = await supabaseBrowserClient().auth.oauth.getAuthorizationDetails(id);
      if (cancelled) return;
      if (failure || !data) {
        setStep({ kind: 'invalid', reason: NOT_VALID });
        return;
      }
      // Already approved for this app: the Auth server answers with where to go back to.
      if (!('authorization_id' in data)) {
        setStep({ kind: 'leaving' });
        window.location.replace(data.redirect_url);
        return;
      }
      setStep({
        kind: 'confirm',
        id: data.authorization_id,
        clientName: data.client?.name || 'An app',
        returnsTo: consentReturnHost(data.redirect_uri),
        email: data.user?.email || '',
      });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const answer = async (id: string, approve: boolean) => {
    setWorking(true);
    setError(null);
    const oauth = supabaseBrowserClient().auth.oauth;
    const { data, error: failure } = approve
      ? await oauth.approveAuthorization(id, { skipBrowserRedirect: true })
      : await oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (failure || !data?.redirect_url) {
      setWorking(false);
      setError(failure?.message || 'The answer could not be recorded. Try again.');
      return;
    }
    setStep({ kind: 'leaving' });
    window.location.assign(data.redirect_url);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[radial-gradient(circle_at_80%_0%,rgba(0,163,255,0.14),transparent_45%),radial-gradient(circle_at_0%_100%,rgba(30,64,175,0.10),transparent_45%)]">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border-t-4 border-brand-cyan p-8">
        <div className="mb-6 text-center">
          <div className="flex justify-center mb-2">
            <BrandLogo size={44} />
          </div>
          <div className="text-sm text-ink-3">Connect an app</div>
        </div>

        {step.kind === 'loading' && <div className="text-sm text-gray-500 text-center">Checking the request…</div>}

        {step.kind === 'leaving' && <div className="text-sm text-gray-500 text-center">Taking you back…</div>}

        {step.kind === 'invalid' && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{step.reason}</div>
        )}

        {step.kind === 'confirm' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              <span className="font-medium">{step.clientName}</span> is asking to use tapestr.ai as{' '}
              <span className="font-medium">{step.email || 'you'}</span>.
            </p>
            <p className="text-sm text-gray-700">
              It acts as this account, so it sees what this account can see. The tools it is given read data and prepare drafts and staged loads. None of them changes live records, rules or settings.
            </p>
            <p className="text-sm text-gray-500">
              When you answer, you go back to <span className="font-medium text-gray-700">{step.returnsTo}</span>. Approve only if you started this from there.
            </p>
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{error}</div>}
            <button
              type="button"
              onClick={() => { void answer(step.id, true); }}
              disabled={working}
              className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:brightness-110 font-medium disabled:bg-none disabled:bg-gray-300"
            >
              {working ? 'Working…' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => { void answer(step.id, false); }}
              disabled={working}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              Do not connect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
