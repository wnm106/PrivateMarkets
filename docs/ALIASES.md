# Aliases

People do not use the catalog's codes. A borrower is an issuer, a tranche is a security, ending NAV is NAV, and a project name is the borrower's name. Four lists store those words. Import mapping and chat search read the same lists.

| What someone says | List | Means |
|---|---|---|
| Ending NAV, Net Assets | `metadata_register.attribute_aliases` | One field. Ending NAV is `NAV` on a fund. |
| Borrower, Tranche, Portfolio | `metadata_register.domain_aliases` | One entity type. Borrower is `ISSUER`. Tranche is `SECURITY`. |
| Borrower name, Project name | `metadata_register.entity_name_aliases` | The record's `entity_name`, not a separate field. Project name is the borrower name. |
| Project Falcon | `entity_instances.entity_aliases` | One record. Project Falcon is the borrower whose legal name is different. |

A list value's other spellings stay on `reference_list_values.synonyms`. That is the value inside a field, not the field, the type, or the record.

## Entity types

`domain_aliases` holds one label and one code per entity type. `BORROWER` belongs to `ISSUER` only. The seeded words are:

| Entity type | Also called |
|---|---|
| `ISSUER` | Borrower, Obligor, Company |
| `SECURITY` | Tranche, Instrument |
| `FUND` | Portfolio, Vehicle |
| `POSITION` | Holding |
| `DEAL` | Transaction |
| `CASH_FLOW` | Cash flow |

The deal tranche type's own name is also Tranche. A column that is only the word Tranche follows that type, because a type's own name wins over another type's alias. "Tranche name" is a name alias of `SECURITY` and follows the security.

## Entity names

`entity_name_aliases` says which column words are the name of a record of that type. "Project name" and "Borrower name" are both the issuer's name. The first such column in a file is the record name. Another one is stored as an alias of that record, under its alias code (`PROJECT_NAME`).

`entity_aliases` is the other name of a specific record. Search matches it. An import that has already matched the record by its legal name still matches a later file that only has the project name. Loading a project-name column writes or replaces that alias.

The record page has an Aliases tab. It lists those names, and a name added there is the same row search and import use. The kind list is the entity type's name aliases, such as Project name for an issuer.

## Fields

`attribute_aliases` maps statement and file wording onto one attribute inside a domain. "Ending NAV" and "Net Assets" are `NAV`. Statement templates add a row when a line's label differs from the attribute's name. Import mapping treats an exact alias as a semantic match.

## How a column is read

For a file aimed at one entity type, a header is checked in this order:

1. An entity-name alias for that type ("Project name") becomes `entity_name`, or `entity_alias:<CODE>` when the name is already taken.
2. An attribute alias ("Ending NAV") becomes that attribute.
3. The entity-type alias on its own ("Borrower") becomes the record name.
4. The remaining headers are matched to attribute codes and names, with the type's alias words ignored so "Borrower country" can still match `COUNTRY`.

Chat uses the same lists:

- `search_attributes` returns the field, and says which alias matched. "Project name" comes back as `entity_name` on `ISSUER`. "Borrower" comes back as the entity type `ISSUER`.
- `list_domain_types` includes each type's aliases.
- `search_entities` matches a record's name and its stored aliases. A hit on the alias says which name matched.
- `get_template_metadata` includes each field's alias labels.

## Per client

The lists above are shared by every client. A client can add to them, and two more settings belong to one client. None of this changes a code or a stored value.

| Setting | Table | What changes |
|---|---|---|
| What the client calls an entity type | `metadata_register.client_domain_settings` | The type's name wherever it is shown: menus, search, record pages, the assistant. `ISSUER` can be Borrower for one client and Company for another. |
| A shared field the client hides | `metadata_register.client_attribute_settings` | The field leaves that client's record pages, forms, column lists and the Excel add-in. Its values stay stored, and calculations, compliance and saved views still read them. A field every record must have cannot be hidden. |
| A word the client uses for an entity type | `metadata_register.domain_aliases` with a `client_id` | Import mapping, chat search and the Excel formula builder read it for that client only. It wins over a shared alias with the same words, so Portfolio can mean a fund for everyone and an account for one client. |

All three are set on an entity type's admin page, on the **For this client** tab, by someone who may edit that client's entities. The tab counts the records holding a value in each field today, and can hide every shown field that has none.

### A client's words

`entity_name_aliases` and `attribute_aliases` take a `client_id` the same way: NULL is a shared alias, and a client's own row is read by that client only. An alias code is unique among the shared aliases and again inside each client.

`metadata_register.alias_words(client)` is the one place that puts the words together for a client, in the order they win:

1. The client's own aliases, and the name it gives an entity type.
2. The catalog name of a type the client renamed, unless the client uses that word for something else.
3. The shared aliases, except one whose words the client uses itself.

"<name> name" is the record name of a type for each name and alias the client gives it, so naming `ISSUER` Borrower makes "Borrower name" the issuer's name with no second entry. A word cannot be what the client already calls another type.

A signed-in request calls `public.session_alias_words()`, which uses the session's client. Server code that loads a file for a client calls `alias_words` with that client. Both go through `loadAliasWords` in `packages/graphql/src/lib/semantic-aliases.ts`; no other code reads the three lists to match on. The answer also carries the client's names for entity types and the fields it hides, so import mapping lists a type under the client's name and marks a hidden field "hidden for this client". A hidden field can still be loaded.

### Whose settings a session reads

`tenancy.presentation_client_id()` is the one place that decides. It is the client staff are simulating, the client a sign-in chose, or the person's only client. Staff who are not simulating a client, and a session in several clients, get none: they read the catalog's own names and every field.

The public views apply it, so no reader has to:

- `public.domain_types.domain_name` is the client's name where it has one. `catalog_domain_name` is the catalog's.
- `public.attribute_register.is_visible` is false for a field the client hides. `catalog_is_visible` is the catalog's own flag, and `hidden_for_client` says the client hid it.

Those two columns cannot be written through the views. Code that changes the catalog's name or visible flag writes `metadata_register.domain_types` or `metadata_register.attribute_register`. An edit screen reads `catalogName` and `catalogIsVisible`, so it never saves one client's setting into the catalog.

Server code that runs with the service role has no session client. When it knows which client a job is for, it calls `metadata_register.client_domain_labels(client)` and `metadata_register.client_hidden_attribute_ids(client)`.

### Not built yet

- The tab edits a client's words for an entity type. A client's own record-name and field aliases can be stored and are read, but have no screen yet.
- The import screens name an entity type with `domainLabel` in a few places outside the target list (a heading, a fallback label). Those still show the built-in label, not the client's name.
- A surface or narrative that spells an entity type's name in its own text does not follow a client's name.
