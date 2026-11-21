'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { excelSessionMessage } from '@tapestrai/graphql/src/lib/excel-session';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { MfaStep } from '@/components/auth/MfaStep';
import { SignInForm } from '@/components/auth/SignInForm';
import { EXCEL_CONNECT_PATH } from '@/lib/session-store';
import { forgetBrowserSession, publicSupabaseConfig, supabaseBrowserClient } from '@/lib/supabase-browser';

/**
 * The Excel add-in opens this page in an Office dialog (docs/EXCEL_ADDIN.md).
 *
 * The person signs in here with their own account, by whatever method their
 * organization allows, into a session made for Excel alone. Once their sign-in
 * rules and any authenticator step are met and they confirm, the session is sent
 * to the add-in with Office's messageParent and forgotten by this browser, so the
 * add-in is its only holder. Office delivers the message only to an add-in page
 * on this same origin.
 */

const OFFICE_JS = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';

interface OfficeDialogHost {
  onReady: () => Promise<unknown>;
  context?: { ui?: { messageParent?: (message: string) => void } };
}

declare global {
  interface Window {
    Office?: OfficeDialogHost;
  }
}

type Step =
  | { kind: 'loading' }
  | { kind: 'signin'; error: string | null }
  | { kind: 'mfa' }
  | { kind: 'confirm'; email: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'sent'; email: string }
  | { kind: 'outside' };

type SignInDecision = { allowed?: boolean; reason?: string | null; mfa_required?: boolean; mfa_satisfied?: boolean };

/** Load office.js once. It clears history.pushState/replaceState, which the router needs. */
function loadOffice(): Promise<OfficeDialogHost | null> {
  const ready = async (office: OfficeDialogHost | undefined) => {
    if (!office) return null;
    await Promise.race([office.onReady().catch(() => null), new Promise((resolve) => setTimeout(resolve, 4000))]);
    return office;
  };
  if (window.Office) return ready(window.Office);
  return new Promise((resolve) => {
    const { pushState, replaceState } = window.history;
    const restore = () => {
      if (!window.history.pushState) window.history.pushState = pushState;
      if (!window.history.replaceState) window.history.replaceState = replaceState;
    };
    const script = document.createElement('script');
    script.src = OFFICE_JS;
    script.async = true;
    script.onload = () => { restore(); void ready(window.Office).then(resolve); };
    script.onerror = () => { restore(); resolve(null); };
    document.head.appendChild(script);
  });
}

function canSendToAddIn(office: OfficeDialogHost | null): boolean {
  return typeof office?.context?.ui?.messageParent === 'function';
}

export function ExcelConnect() {
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [working, setWorking] = useState(false);
  const officeRef = useRef<OfficeDialogHost | null>(null);

  const evaluate = useCallback(async () => {
    const client = supabaseBrowserClient('excel');
    const urlError = new URLSearchParams(window.location.search).get('error');
    const { data: userData } = await client.auth.getUser();
    if (!userData.user) {
      setStep({ kind: 'signin', error: urlError });
      return;
    }
    // The same rules middleware applies to the app session.
    const { data, error } = await client.schema('tenancy').rpc('current_sign_in_decision');
    const decision = (!error && data && typeof data === 'object' ? data : null) as SignInDecision | null;
    if (decision?.allowed === false) {
      await client.auth.signOut({ scope: 'local' });
      setStep({ kind: 'blocked', reason: decision.reason || 'This sign-in method is not allowed for this organization.' });
      return;
    }
    if (decision?.mfa_required && decision.mfa_satisfied === false) {
      setStep({ kind: 'mfa' });
      return;
    }
    setStep({ kind: 'confirm', email: userData.user.email || '' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadOffice().then(async (office) => {
      if (cancelled) return;
      officeRef.current = office;
      if (!canSendToAddIn(office)) {
        setStep({ kind: 'outside' });
        return;
      }
      await evaluate();
    });
    return () => { cancelled = true; };
  }, [evaluate]);

  const connect = async () => {
    const office = officeRef.current;
    const send = office?.context?.ui?.messageParent;
    if (!send) {
      setStep({ kind: 'outside' });
      return;
    }
    setWorking(true);
    try {
      const client = supabaseBrowserClient('excel');
      // From here on the add-in refreshes this session. This page must not.
      client.auth.stopAutoRefresh();
      const { data } = await client.auth.getSession();
      const session = data.session;
      if (!session) {
        setStep({ kind: 'signin', error: 'Your sign-in ended. Sign in again.' });
        return;
      }
      send(excelSessionMessage({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in || 3600),
        userId: session.user.id,
        email: session.user.email || '',
        supabaseUrl: publicSupabaseConfig.url,
        anonKey: publicSupabaseConfig.anonKey,
      }));
      forgetBrowserSession('excel');
      setStep({ kind: 'sent', email: session.user.email || '' });
    } finally {
      setWorking(false);
    }
  };

  const switchAccount = async () => {
    setWorking(true);
    try {
      // Never sent to Excel, so revoke it rather than only forget it.
      await supabaseBrowserClient('excel').auth.signOut({ scope: 'local' });
      setStep({ kind: 'signin', error: null });
    } finally {
      setWorking(false);
    }
  };

  const onSignedOut = useCallback(() => setStep({ kind: 'signin', error: null }), []);

  if (step.kind === 'signin') {
    return (
      <SignInForm
        store="excel"
        subtitle="Sign in to connect Excel"
        initialError={step.error}
        nextPath={() => EXCEL_CONNECT_PATH}
        onSignedIn={() => { void evaluate(); }}
      />
    );
  }
  if (step.kind === 'mfa') {
    return <MfaStep store="excel" onVerified={() => { void evaluate(); }} onSignedOut={onSignedOut} />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[radial-gradient(circle_at_80%_0%,rgba(0,163,255,0.14),transparent_45%),radial-gradient(circle_at_0%_100%,rgba(30,64,175,0.10),transparent_45%)]">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border-t-4 border-brand-cyan p-8">
        <div className="mb-6 text-center">
          <div className="flex justify-center mb-2">
            <BrandLogo size={44} />
          </div>
          <div className="text-sm text-ink-3">Connect Excel</div>
        </div>

        {step.kind === 'loading' && <div className="text-sm text-gray-500 text-center">Checking your sign-in…</div>}

        {step.kind === 'outside' && (
          <div className="space-y-2 text-sm text-gray-700">
            <p>Open this page from Excel.</p>
            <p className="text-gray-500">In Excel, open the Tapestry pane and choose <span className="font-medium">Sign in</span>. Excel opens this page and receives your sign-in when you confirm.</p>
          </div>
        )}

        {step.kind === 'blocked' && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{step.reason}</div>
        )}

        {step.kind === 'confirm' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              Excel will read Tapestry data as <span className="font-medium">{step.email || 'you'}</span>. Formulas show only what this account can see.
            </p>
            <button
              type="button"
              onClick={() => { void connect(); }}
              disabled={working}
              className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:brightness-110 font-medium disabled:bg-none disabled:bg-gray-300"
            >
              {working ? 'Connecting…' : 'Connect Excel'}
            </button>
            <button
              type="button"
              onClick={() => { void switchAccount(); }}
              disabled={working}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              Use a different account
            </button>
          </div>
        )}

        {step.kind === 'sent' && (
          <p className="text-sm text-gray-700 text-center">Excel is connected as <span className="font-medium">{step.email}</span>. You can close this window.</p>
        )}
      </div>
    </div>
  );
}
