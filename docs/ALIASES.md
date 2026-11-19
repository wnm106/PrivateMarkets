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
