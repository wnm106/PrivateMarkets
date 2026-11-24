# Documents

Load data turns a file into values. Documents keeps the words: an agreement is read into its sections and clauses, each tied to the records it is about, tagged, and searchable by meaning. Documents are at `/documents`; types and templates are at `/admin/document-templates`.

## Parts

| Part | Where | What it does |
|---|---|---|
| Tables and functions | `supabase/migrations/20261118150000_document_content.sql` and the four that follow it | The `docs` schema, reached only through the `document_*` functions, and the private `documents` storage bucket |
| Reader, chunker, templates, embedding | `packages/graphql/src/lib/document-content` | Pure code with tests: file to text, headings, chunks; template drawing and matching; the Voyage client; the pipeline |
| Outside reader | `packages/mcp-server/src/feeds/llama-parse.ts`, `packages/graphql/src/lib/document-content/reading.ts` | LlamaParse, for a file with no text this server can read; the reading of every page it returns, and where a reading is kept |
| Job | `packages/worker/src/documents.ts` | `document.process` |
| Describer | `packages/worker/src/document-refiner.ts` | Claude, writing a description and topics for tables and lists |
| Command line | `packages/worker/src/documents-cli.ts` | Add, process and search without a running worker |
| API | `packages/graphql/src/resolvers/documents.ts` | What the screens call |
| Upload | `apps/web/app/api/documents/route.ts` | Stores the file and queues it |
| Agent tools | `packages/mcp-server/src/tools/document-tools.ts` | `search_documents`, `list_documents`, `get_document_section` |

## What happens to a file

1. **Stored.** The file goes to `documents/<client id>/<document id>/<file name>`. A document is identified by its content: the same file for the same client is held once.
2. **Read.** HTML, text and PDFs with a text layer are read on the worker, with no outside service. A scan, a picture of a page or a Word file has no text the worker can read itself, so it is read by the outside reader (see The outside reader below), and refused with a reason when none is set up. Either way the reader produces the body (the whole text: paragraphs, tables, the notes under them and the footnotes), the headings, and the chunks.
3. **Tagged.** Each heading is placed on a section of the type's published template.
4. **Refined.** A passage that is mostly names and numbers gets a one-sentence description and topics from a model. Only those passages are sent, and only when `ANTHROPIC_API_KEY` is set. See Refinement below.
5. **Embedded.** Each chunk gets a vector. The whole text is sent to the embedding service here, and only when `VOYAGE_API_KEY` is set. Without it the document is still searchable by words.

`document.process` runs these in order. Embedding saves as it goes, so a run the embedding service slows down carries on from where it stopped. Reading a file again keeps the vector, description and topics of every passage whose words, place and headings did not change, so only what changed is described and embedded again. Nothing runs until a worker is running (see [JOBS.md](JOBS.md)); to work on one document without it:

```
npm run documents --workspace @tapestrai/worker -- add <file> --type CREDIT_AGREEMENT --entity <entity code>:BORROWER
npm run documents --workspace @tapestrai/worker -- process <document id>
npm run documents --workspace @tapestrai/worker -- pending
npm run documents --workspace @tapestrai/worker -- search "what are the financial covenants"
```

## The outside reader

LlamaParse reads what a text layer cannot: a scan, a photographed page, a Word file. It is the same reader Load data sends a document to for its tables, and one call returns both:

- **The tables**, which Load data maps and loads.
- **The reading**: every page as markdown, with its paragraphs, its tables as rows of words, the notes under a table and the footnotes at the foot of the page.

The reader returns a page's header and footer apart from its body. A line that runs along most pages (the document's name, "Page 3 of 90") is page furniture and is left out. A footer that differs from page to page is a footnote or a note, and is kept with its page. The reading is read into blocks that keep their page, so a passage found in it is cited by page like any other.

A reading is kept once for each client and file content, at `documents/<client id>/readings/<sha-256 of the file>.json`. A file read when it was loaded is not sent out again when it is indexed, and a document read once is not sent again when it is read again.

| Setting | Meaning |
|---|---|
| `LLAMA_CLOUD_API_KEY` | Turns the outside reader on. Needed by the worker (to read a document) and by the web app (to read an upload in Load data). Without it a scan, a picture or a Word file is refused, with the reason on the document |
| `LLAMA_PARSE_TIER` | Default `cost_effective` |

The file leaves for LlamaParse here, and only here: a PDF with selectable text, an HTML file and a text file never do.

## Headings and chunks

Headings come from how agreements number themselves (`SECTION 7`, `ARTICLE VI`, `7.1`, `SECTION 3.6`, `EXHIBIT A`, `SCHEDULE 1.1A`), from bold run-in headings (`7.2 Indebtedness. Create, ...`), and from heading marks in HTML and markdown.

A scanned PDF with a text layer is read too, and its headings allow for what a scan gets wrong: `SECTION 3. I 7` is 3.17, `SECTION 4,2` is 4.2, `ARTICLEll.` is Article II. Only a heading in capitals is given that benefit. An article is known by its number whether roman or arabic, so a line that opens "8.2. Except as provided" under Article IX is a reference, not a heading. A document writes its numbered headings one way (`SECTION 3.6`, or bare `3.6`); lines that open another way are references too. A table of contents lists the same headings with nothing between them, which is how it is told apart from the body and left out. Two levels are kept.

A chunk never crosses a heading. Within a section:

- a new clause label, `(a)`, starts a new chunk once the current one is long enough;
- each defined term is its own chunk, tagged with the term;
- the rows of a table stay together, with a short caption line above them;
- a paragraph longer than the limit is cut at a sentence end.

Each chunk carries what a citation needs:

| Field | What it is |
|---|---|
| `text` | The exact words. The database cuts them from the body by the chunk's offsets, so they cannot differ from the document. |
| `char_start`, `char_end` | Where the words sit in the body |
| `locator` | Page, clause label, the headings above, and for HTML the offsets in the original file |
| `tags` | See below |
| `embedding` | 1,024 numbers from the embedding model |

Offsets count characters of the body. The reader replaces characters outside the basic plane (emoji and the like) with one placeholder character, so JavaScript and Postgres count the same.

## Tags

Tags are plain strings on chunks. Search can require any set of them.

| Tag | Set by |
|---|---|
| `type:CREDIT_AGREEMENT` | The document's type |
| `section:NEGATIVE_COVENANTS` | The template section of the chunk's heading, and of the heading above it |
| `kind:clause`, `kind:definition`, `kind:table`, `kind:front` | The chunker |
| `topic:lenders` | Refinement, or a person, from the template's topics |
| `term:applicable margin` | The chunker, on a definition |
| anything else | A person, on the document or on a template section. Every chunk under it carries the tag. |

A chunk's tags are rebuilt whenever the document's tags, type, template or section choices change.

## Templates

A template lists the sections a kind of document is expected to have: a title, other wordings that mean the same section, tags, guidance, and whether every document should have it. It has two levels, like the headings.

- **Draw.** Tick one or more read documents and draw a draft. Headings are grouped across the documents by their words, ignoring numbers, so `7.1 Financial Condition Covenants` and `6.12 Financial Covenants` become one section with the second as another wording. Each section records how many of the documents had it.
- **Refine.** Rename, reorder, merge, remove and add sections; add other wordings and tags. Ticking more documents adds only what the draft lacks and changes nothing a person set.
- **Publish.** Publishing retires the version it replaces and tags every document of the type against the new one. Its tables and lists are then described again by the worker, so they are filed under the new version's topics; what a person wrote is kept. A published template is never changed; start a new draft from it.

Renaming a section keeps its old name as another wording, so a heading written the old way still lands on it. That matters for scans: the template can say "Formation of Limited Partnership" while the document's own heading reads "Formation of Limited Pm1nership".

Two headings of one document never become one section, however alike their wording. "Limited Partners" and "Additional Limited Partners" are two articles. Alike headings are joined only across documents.

A heading is placed on a section by the same words, then a known other wording, then similar words, then (with an embedding key) similar meaning. A section a person chose on a document is kept when the document is tagged again. A client's own published template is used before the shared one.

## Refinement

A table of lenders and amounts has no sentence in it. Its vector means little and a question shares few words with it, so search passes it by. Refinement is what is done about that.

- **Thin passages.** The chunker marks a passage thin when it is a table, when half its lines are a label and a value (`By:`, `Name:`, `Title:`), or when fewer than about two words in ten are ordinary function words. On a 137-page credit agreement that was 20 passages of 728: tables, schedules, signature blocks, the notice addresses and a few terse definitions.
- **Description and topics.** For each thin passage the model is given the passage, the headings above it, the end of the passage before it, and the template's topics. It writes one sentence saying what the passage holds and picks the topics it is about. The topics become tags (`topic:lenders`). The description is word-indexed and embedded with the passage.
- **Never the citation.** `chunks.text` stays the document's own words. The description is kept apart in `chunks.summary`, shown as "Described as", and the agent tools tell the model not to quote it.
- **Corrections.** On the document's page a person can describe any passage and choose its topics. What a person wrote is marked `MANUAL` and is not overwritten when the document is refined or read again. The passage is embedded again by the worker.
- **When the model cannot be reached.** The step never fails the document. The passages stay as they are, the document's message says so, and the next read tries again.

### Topics

A template lists the subjects its documents cover, each with a short description: lenders, pricing, fees, financial covenants. They cut across sections; lenders appear in the preamble, a schedule and the signature pages. A new draft starts with a list for its type (see `defaultTopics` in `refine.ts`), and a person changes it on the template page. The description matters: a search question is compared with it.

## Search

`document_search` ranks chunks by vector distance and by the words of the question, and joins the lists by reciprocal rank, so a chunk found both ways comes first. Filters are tags (all must be present), linked records, document types and documents.

It does not pick a branch of the template and search only there. Instead it routes: each topic and top section of a published template has a vector, the question is compared with them, and the passages carrying the closest topic, and those under the closest top section, are added as further ranked lists at less than a full vote (0.75 for a topic, 0.2 for a section). So a table filed under Lenders is found by a question about lenders even when neither its words nor its own vector match. A wrong route only adds a few candidates; it never hides the rest. Each result says how it was found and which topic or section brought it forward. To search one branch only, pass its tag as a filter.

Routes are built when a template is published, or by the worker the next time it reads a document of the type.

### The second pass

Joining lists by rank has a weakness: a passage that is a middling match two ways outranks one that is by far the closest in meaning but shares no words with the question. So the best 30 candidates are ranked again by a reranking model, which reads the question and each passage together and scores how well the passage answers it. The model is given each passage's headings, its description if it has one, and the first 1,600 characters of its words. Results come back in that order, each with a `relevance` from 0 to 1.

The pass sends the question and those candidates to the same service that embeds them. If it is rate limited or fails, the search returns the joined order and says so.

The agent tools return `quote` and `citation` for each passage and tell the model to quote the words rather than restate them.

### Answering a question

On a document, on the documents page, and on a record's Documents tab, a question does more than list passages. The same search runs first. A model may search once more and read a section in full, then writes a short summary and names the sections it used. The screen shows that summary, then those sections in the document's own words. `POST /api/documents/ask` does this. The model is `DOCUMENT_ANSWER_MODEL`, or the describer's model, and each turn is recorded as `document.answer`. With no Anthropic key the passages are still shown, grouped under their headings, and the result says no summary was written. The command line search stays a list of passages.

## Embedding

Anthropic has no embedding model. The default is Voyage AI's `voyage-4` at 1,024 dimensions. The heading path is embedded along with the chunk's words, so a clause is embedded knowing where it sits.

| Setting | Meaning |
|---|---|
| `VOYAGE_API_KEY` | Turns on embedding and search by meaning. Needed by the worker (to embed chunks) and by the web app and API (to embed a question). |
| `DOCUMENT_EMBEDDING_MODEL` | Default `voyage-4`. A different model needs every chunk embedded again. |
| `DOCUMENT_RERANK_MODEL` | Default `rerank-3`. `off` turns the second pass off. |
| `VOYAGE_API_BASE` | Default tries `https://ai.mongodb.com/v1` (a key from MongoDB Atlas), then `https://api.voyageai.com/v1`. |
| `ANTHROPIC_API_KEY` | Turns on refinement, and the summary when someone asks a question on a document screen. The worker reads the repository `.env`. The web app uses its own environment, then that same file. |
| `DOCUMENT_REFINE_MODEL` | Default `claude-opus-5-5`, at low effort. Each call is recorded in agent usage as `document.refine`. |

The model is recorded on each chunk. The column holds 1,024 dimensions; a model of another size needs a migration.

## Linked records

A document is linked to the records it is about, each with what the record is to it (borrower, lender, fund, subject). Links are set when the document is added, or afterwards on the document's Details tab: search for a record by name or code, pick it, choose its role, and save. A document can only be linked to a record that already exists.

Each record's page has a Documents tab. It lists the documents linked to that record with the record's role in each, searches across just those documents, and its Add a document button opens the form with the record already linked (`/documents?link=<record id>`).

Links are per document, not per passage: every passage counts as being about all the document's records.

## Files from Load data

A file loaded through Load data can be kept as a document too, so it is searchable and shows on a record's Documents tab. The File intake workflow does this as its first step (`index_position_file_import`, in `packages/mcp-server/src/feeds/import-document.ts`):

- A document is indexed as the file itself, so every page is read and not only its tables. A PDF with a text layer, an HTML file or a text file is read on the worker. A scan, a picture or a Word file is indexed as the outside reader read it, from the reading kept when the file was loaded.
- A spreadsheet, a CSV or a JSON file is indexed as a text rendering of the tables read from it: a heading per table, then its rows, or for a statement each label with its value. A very long table is cut at 3,000 rows. So is a scan when no outside reader is set up.

A file is indexed when a workflow loads it (`load_position_file_table`, `load_nav_report`), when it is stored by a workflow step (`create_position_file_import`, for a document), and by the File intake workflow's first step. `get_position_file_text` gives the same words a page at a time, or the passages that hold what is asked for, before the file is indexed and without the embedding service.

The document is filed as a Financial statement, a NAV statement or a Data file, tagged `source:load-data`, and kept on the file (`import_instances.document_id`). The same content is held once: a second file with the same content uses the document already there. A file that cannot be indexed still loads; the reason is kept on the file.

## Permissions

Any member of a client can read and search that client's documents. `document.manage` lets a person add and remove documents, link them to records, tag sections by hand and change templates. Client admins have it. A document type or template with no client is shared; only a tenant admin changes those.

## Not built yet

- Searching a page by how it looks. A chunk's vector is made from its words, so a chart, a diagram or a stamp with no caption is not found. That needs page images and an embedding model that reads them, and a second vector on each page.
- Azure Document Intelligence as the outside reader for a document's words. It is the fallback for tables in Load data only.
- Highlighting a passage on the page image of a PDF. The locator keeps the page; the screen shows the text.
- Tying a value loaded from a document to the chunk it came from.
- Feeds do not deliver documents; they are added by hand, from the command line, or by the File intake workflow from a file in Load data.
