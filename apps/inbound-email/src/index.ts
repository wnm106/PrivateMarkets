import { receive, type Env, type InboundMessage } from './receive';

/**
 * Cloudflare Email Worker. Email Routing's catch-all for the inbound domain
 * sends every message here. See receive.ts for what is taken and what is refused.
 */
export default {
  async email(message: InboundMessage, env: Env): Promise<void> {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      // Not set up. Refuse rather than drop mail without a word.
      message.setReject('Mailbox unavailable');
      console.error('inbound-email: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
      return;
    }
    const outcome = await receive(message, env);
    // Only ids and verdicts are logged, never addresses or content.
    console.log(JSON.stringify({ event: 'inbound-email', ...('refused' in outcome ? { refused: outcome.refused } : outcome) }));
  },
};
