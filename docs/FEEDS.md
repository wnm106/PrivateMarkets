# Feeds

A feed is a file that arrives on its own and loads through a saved map, with nobody uploading it. Feeds are set up at `/admin/feeds`. They run on the job worker (see [JOBS.md](JOBS.md)).

## Parts

| Part | Where | What it does |
|---|---|---|
| Tables and functions | `supabase/migrations/20261114210000_feeds.sql`, `20261114220000_feed_sftp.sql` | `ops.connections`, `ops.feeds`, `ops.received_files`, reached only through the `feed_*` functions |
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

Inbound email is not built yet. `entity_instances.data_connections` and `data_loaders` are superseded by feeds; their API no longer returns stored header or sign-in values.
