# Feeds

A feed is a file that arrives on its own and loads through a saved map, with nobody uploading it. Feeds are set up at `/admin/feeds`. They run on the job worker (see [JOBS.md](JOBS.md)).

## Parts

| Part | Where | What it does |
|---|---|---|
| Tables and functions | `supabase/migrations/20261114210000_feeds.sql`, `20261114220000_feed_sftp.sql`, `20261119120100_feed_email.sql` | `ops.connections`, `ops.feeds`, `ops.received_files`, `ops.inbound_messages`, reached only through the `feed_*`, `email_*` and `inbound_message_*` functions |
| Email Worker | `apps/inbound-email` | Cloudflare Email Worker: refuses mail it should not take, stores the rest and queues screening |
| Screening | `packages/worker/src/email.ts`, `email-screen.ts` | `email.screen`: checks the sender, DKIM and attachments, and hands accepted attachments to the feeds |
| Connectors | `packages/worker/src/connectors.ts` | List, fetch and tidy files for each kind of connection |
| Jobs | `packages/worker/src/feeds.ts` | `feed.poll`, `feed.check`, `connection.check` |
| Loader | `packages/worker/src/feed-loader.ts` | Loads a file through its saved map, the same way Load data does |
| API | `packages/graphql/src/resolvers/feeds.ts` | What the admin page calls |

## Connections

A connection is a place files come from.

**Drop folder (`STORAGE`).** A folder in the private `feed-inbox` storage bucket. The path is always `feed-inbox/<client id>/<folder>`, so a client can only ever read its own files. Put files there with the Supabase dashboard, the storage API, or any S3 client pointed at the project's S3 endpoint. After a poll:

| The file | Moves to |
|---|---|
| Loaded, or the same content as one already loaded | `processed/` |
| Did not fit the map | `review/` |
| Failed three times | `failed/` |
| Failed once or twice | Stays, and is tried on the next poll |

**Web address (`HTTP`).** An `https` address the worker downloads from. The feed's path is added to the connection's address, and `{YYYY}`, `{MM}`, `{DD}` become the date of the poll (UTC). A `404` means the file is not published yet; it is not an error. Sign-in is none, a bearer token, a user name and password, or a key in a named header.

**SFTP server (`SFTP`).** A folder on an SFTP server, signed in with a password or a private key. Files are taken by name pattern. After a poll, handled files move to `processed/`, `review/` or `failed/` subfolders on the server, as for a drop folder. For a server we can only read, set the connection to leave files where they are; the ledger alone then stops a file being loaded twice, at the cost of downloading it on every poll.

Pin the server's host key. Save the connection without one and press Check: the result shows the key the server presented (`SHA256:…`). Paste that into the connection. From then on a server presenting a different key is refused before any credential is sent.

The worker runs inside the network, so an address a person types must not reach internal services. For web addresses only `https` is allowed, redirects are refused, and a feed path cannot point at a different host from its connection. For both web addresses and SFTP, private, loopback and link-local addresses are refused. `FEED_ALLOW_PRIVATE_HOSTS=true` lifts that for testing against a server on your own machine; never set it where the worker can reach an internal network.

**Email (`EMAIL`).** Attachments sent to the connection's own address. See [Inbound email](#inbound-email).

### Credentials

A connection's credential goes to Supabase Vault through `feed_connection_save`. Only `feed_poll_context` and `feed_connection_context` read it, and only the service role may run those. No query returns it, the admin page never receives it, and the settings JSON keeps only known keys, so a credential typed into the wrong box is dropped rather than stored in the open.

## Feeds

A feed is one recurring file: a connection, a path, the file names to take, and the saved map that loads it.

Load one file of the kind by hand in Load data first; the feed form then lists its map. Load data saves two kinds of map, and a feed works with either:

- **Signature maps** (ordinary tables) are found by a file's exact set of column headers.
- **Layout maps** (statements and other recognised documents) carry the file's columns.

A map with neither cannot tell whether an unattended file is the right shape, so it is not offered.

**Looking for files.** A cron expression. Saving the feed creates a `feed.poll` schedule for it, which shows in Jobs. Leave it blank to poll only with Poll now.

**Expecting a file.** An optional cron expression and a grace period. The next file is expected at the first slot after the last one arrived. Once that time plus the grace period has passed, the feed is late. Schedule a `feed.check` job to report late feeds; it fails and names them.

## What a poll does

For each file the connector lists:

1. Fetch it and take the SHA-256 of its content.
2. Ask the ledger (`feed_file_begin`). New content, or content that failed before with attempts left, is loaded. Anything else is skipped.
3. Load it through the feed's map.
4. Record the outcome (`feed_file_finish`) and let the connector tidy the source.

A file is identified by its content, not its name. The same content is loaded once per feed, however often it is seen and whatever it is called.

### When a file does not fit

Nobody is watching an unattended load, so it only goes ahead when the file is exactly the shape the map was saved for. Otherwise the file is stored in Load data for a person, marked `NEEDS_REVIEW`, and not loaded:

- it is missing columns the map needs, or
- it has columns the map has not seen, which would otherwise be mapped by guesswork.

For a signature map both come to the same thing: the file's headers are not the set the map was saved for.

A poll with a file that needs review, or that failed, ends as a failed run so it is seen in Jobs. Files that loaded in the same poll stay loaded.

## Permissions

`feed.manage` lets a person create and change connections and feeds for their client, including stored credentials. Client admins have it. Queuing a poll or a check also needs `job.manage`. Any member of a client can see its connections, feeds and received files, but never a credential.

## Adding a connector

1. Implement `Connector` in `packages/worker/src/connectors.ts` and add it to `buildConnector`.
2. Allow the kind in the `ops.connections` check constraint and in `feed_connection_save`.
3. Add its settings to `cleanConnectionConfig` in `packages/graphql/src/lib/feed-config.ts`, keeping only keys that are safe to show.
4. Add its fields to the connection form in `apps/web/app/admin/feeds/page.tsx`.

## Inbound email

Each `EMAIL` connection has its own address, `<token>@<inbound domain>`, for example `3f9c0a…e1@in.tapestr.ai`. The token is 24 random hex characters, so the address cannot be guessed. **New address** on the connection replaces it; mail to the old one is refused from then on. Only people with `feed.manage` see the address.

### How a message travels

1. **Cloudflare Email Routing** receives mail for the inbound domain and hands every message to the Email Worker (`apps/inbound-email`).
2. **The Email Worker** asks the database (`email_inbound_route`) whether to take it, and refuses it while the sending server is still connected when:
   - it is for another domain, or for an address that is not a connection's (or was replaced),
   - the connection is paused,
   - it is larger than the connection allows (25 MB by default; reading stops at the limit whatever size the sender declared),
   - the connection has had its messages for the hour (30 by default).

   Unknown and paused addresses get the same answer, `Address not found`, so a sender cannot tell which addresses exist. A Message-ID the connection has already had is accepted and dropped. Otherwise the raw message is stored, unread, at `feed-inbox/<client>/_email/<connection>/raw/<id>.eml` and recorded in `ops.inbound_messages`, which queues `email.screen`.
3. **`email.screen`** (job worker) checks, in order:
   1. The From header names exactly one address.
   2. That address, or exactly its domain, is one of the connection's allowed senders. A subdomain is not its parent domain.
   3. A DKIM signature passed for the From domain (DMARC alignment, relaxed). The From address alone is trivial to forge; the signature is what proves the sender's domain sent it. A message signed only by some other domain, or changed after it was signed, fails. If a DKIM key lookup fails for now, the job tries again later instead of quarantining.
   4. Each attachment is a type the connection takes (from `.csv`, `.txt`, `.json`, `.xlsx`, `.xls`, `.pdf`; never archives, macro workbooks or executables), is no larger than 25 MB, and its bytes match its type: an `.xlsx` is a zip without a `vbaProject.bin`, an `.xls` has no VBA project, a `.pdf` has no JavaScript, launch actions or embedded files, and text has no binary content. Inline images are ignored.
   5. When a scanner is set up, every attachment left is scanned. Malware rejects the whole message.

   | Result | When | What happens |
   |---|---|---|
   | `ACCEPTED` | All checks pass and at least one attachment is taken | Taken attachments go to `feed-inbox/<client>/_email/<connection>/`, and a poll is queued for each active feed on the connection |
   | `QUARANTINED` | Checks 1 to 3 fail | Nothing is taken. It waits under **Inbound email** on `/admin/feeds`, and the job run fails so it shows in Jobs |
   | `REJECTED` | Nothing could be taken, or malware was found | Nothing is taken. Cannot be released |

4. **The feeds.** The `EMAIL` connector lists accepted attachments by the name the sender gave, so a feed's file name pattern (`NAV_*.xlsx`) works as usual. From there a file is loaded like any other feed file: the content-hash ledger, the saved map, and review when it does not fit. Every feed on an email connection sees the same attachments, so give each its own pattern. Keep a poll schedule on the feed as a backstop; an accepted email also queues a poll straight away.

**Release** screens a quarantined message again without checks 1 to 3. The file checks and the scan still apply. Release only mail you know is genuine, for example a new person at the administrator; then add their address to the allowed senders. **Discard** sets it aside for good. Both need `feed.manage`.

Nothing ever replies to a sender. A reply or bounce to a forged sender is spam of our own, and it tells a spammer the address is live. The only answer a sender gets is the SMTP refusal in step 2.

The message body is never read for instructions or data. Only attachments are loaded, and they go through the saved map like any other feed file.

### Settings on the connection

| Setting | Default | |
|---|---|---|
| Allowed senders | (required) | Whole addresses or domains, one per line |
| Require DKIM | on | Turn off only for a sender whose mail server cannot sign. Without it, anyone who learns the address can send mail that looks like it is from an allowed sender |
| File types | `.csv .xlsx .xls .pdf` | From the safe list only |
| Messages an hour | 30 | Mail over this is refused for the rest of the hour |

### Setting it up

1. **A domain for inbound mail.** Use a subdomain kept for this, for example `in.tapestr.ai`, on the Cloudflare zone that hosts the website. In the Cloudflare dashboard: the zone, **Email**, **Email Routing**, enable it for the subdomain, and let it add its MX and SPF records. Do not use the domain people send ordinary mail to.
2. **The Email Worker.**
   ```bash
   cd apps/inbound-email
   # set INBOUND_EMAIL_DOMAIN in wrangler.toml to the subdomain
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler deploy
   ```
3. **Route the mail.** **Email Routing**, **Routing rules**, **Catch-all address**: action **Send to a Worker**, destination `tapestrai-inbound-email`. The worker refuses anything that is not a connection's address, so the catch-all does not open the domain to everything.
4. **Show the address.** Set `INBOUND_EMAIL_DOMAIN` (the same subdomain) where GraphQL runs: the web app, for `/api/graphql`. If `NEXT_PUBLIC_GRAPHQL_ENDPOINT` points at the Workers API instead, set it there too and add the `nodejs_compat_populate_process_env` compatibility flag so the API can read it. Without it the connection works, but its address is not shown.
5. **A virus scanner (recommended).** Run clamd where the job worker can reach it and set `CLAMAV_HOST` (and `CLAMAV_PORT` if it is not 3310) on the worker. Set `EMAIL_REQUIRE_SCAN=true` to hold every message until a scanner is there: `email.screen` then fails with that reason and the message stays waiting.
6. **Try it.** Create an `EMAIL` connection and a feed on it, then send a file from an allowed sender. The message should show as Accepted under **Inbound email**, and the file under **Received files**. Send one from an address that is not allowed; it should be Quarantined.

The Email Worker logs only message ids and verdicts, never addresses or content.

### Not yet

- Raw messages and quarantined mail are kept. There is no retention job yet.
- Archives (`.zip`) are never taken.
- SPF is not checked: Cloudflare does not hand the worker the sending server's address. DKIM carries the decision.

`entity_instances.data_connections` and `data_loaders` are superseded by feeds; their API no longer returns stored header or sign-in values.
