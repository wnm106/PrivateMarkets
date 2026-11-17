'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import type { MutationErrors } from '@/lib/workflows';

/**
 * Where review notices go besides the assistant briefing: email to each
 * reviewer, and one Slack channel for the client. The Slack address is never
 * shown again once saved. See docs/WORKFLOWS.md.
 */

interface Settings {
  emailEnabled: boolean;
  slackConfigured: boolean;
  canManage: boolean;
  sentLast7Days: number;
  failedLast7Days: number;
}

const FIELDS = 'emailEnabled slackConfigured canManage sentLast7Days failedLast7Days';
const QUERY = `query NotificationSettings { notificationSettings { ${FIELDS} } }`;
const SAVE = `mutation SaveNotificationSettings($emailEnabled: Boolean!, $slackWebhookUrl: String) {
  saveNotificationSettings(emailEnabled: $emailEnabled, slackWebhookUrl: $slackWebhookUrl) { settings { ${FIELDS} } errors { message } }
}`;

const hint: CSSProperties = { fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 };

export function NotificationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(false);
  const [slack, setSlack] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ notificationSettings: Settings }>(QUERY, {}, 'network-only');
    if (result.aborted) return;
    // A person in several clients, or none, has no single client to set this for. Show nothing.
    if (result.error || !result.data) return;
    setSettings(result.data.notificationSettings);
    setEmail(result.data.notificationSettings.emailEnabled);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return null;

  const save = async (slackValue: string | null) => {
    setSaving(true);
    setMessage('');
    const { data, error } = await graphqlMutation<{ saveNotificationSettings: { settings: Settings | null; errors: MutationErrors } }>(SAVE, {
      emailEnabled: email,
      ...(slackValue === null ? {} : { slackWebhookUrl: slackValue }),
    });
    setSaving(false);
    const problem = error?.message || data?.saveNotificationSettings.errors[0]?.message;
    if (problem || !data?.saveNotificationSettings.settings) {
      setMessage(problem || 'The settings could not be saved.');
      return;
    }
    setSettings(data.saveNotificationSettings.settings);
    setSlack('');
    setMessage('Saved.');
  };

  const channels = [settings.emailEnabled ? 'email' : null, settings.slackConfigured ? 'Slack' : null].filter(Boolean);

  return (
    <section style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Review notices</div>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          Sent to the assistant briefing{channels.length > 0 ? `, and by ${channels.join(' and ')}` : ''}.
          {settings.sentLast7Days + settings.failedLast7Days > 0 && ` ${settings.sentLast7Days} sent in the last 7 days${settings.failedLast7Days > 0 ? `, ${settings.failedLast7Days} failed` : ''}.`}
        </span>
        {settings.canManage && !open && (
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Change</button>
        )}
      </div>
      {open && (
        <div style={{ display: 'grid', gap: 10, marginTop: 8, maxWidth: 520, border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
            <input type="checkbox" style={{ marginTop: 2 }} checked={email} onChange={(event) => setEmail(event.target.checked)} />
            <span>Email each reviewer at their sign-in address. The job worker needs RESEND_API_KEY and NOTIFY_EMAIL_FROM.</span>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' }}>Slack incoming webhook</span>
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              value={slack}
              onChange={(event) => setSlack(event.target.value)}
              placeholder={settings.slackConfigured ? 'Saved. Paste a new address to replace it' : 'https://hooks.slack.com/services/...'}
            />
            <span style={hint}>Every notice for this client is posted to that channel. The address is not shown again once saved.</span>
          </label>
          {message && <div style={{ fontSize: 12, color: message === 'Saved.' ? 'var(--ink-3)' : 'var(--red)' }}>{message}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save(slack.trim() ? slack.trim() : null)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {settings.slackConfigured && (
              <button type="button" className="btn btn-sm" disabled={saving} onClick={() => window.confirm('Stop posting notices to Slack?') && void save('')}>
                Remove Slack
              </button>
            )}
            <button type="button" className="btn btn-sm" disabled={saving} onClick={() => { setOpen(false); setMessage(''); setSlack(''); setEmail(settings.emailEnabled); }}>
              Close
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
