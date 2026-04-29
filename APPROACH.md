# Tool dependency graph — approach

## What we built

A directed dependency graph for **Google Super (437 tools)** and **GitHub (867 tools)** Composio toolkits, where an edge `A → B` means *tool A produces a value that tool B requires as input* (e.g. `LIST_THREADS → REPLY_TO_THREAD` because the latter needs a `thread_id`).

Final graph: **712 connected tools, 2,430 edges**, viewable as an interactive Cytoscape.js visualization at `public/index.html`.

## Pipeline

```
fetch-tools.ts   →  raw JSON for both toolkits           (data/{toolkit}_tools.json)
build-profiles.ts → filter + extract producer/consumer profiles  (data/profiles.json)
heuristic-edges.ts → deterministic candidate edges        (data/heuristic-edges.json)
llm-refine.ts    →  LLM judges ambiguous candidates       (data/edges.json)
assemble-graph.ts → final nodes+edges for the viewer      (public/graph.json)
```

Run end-to-end: `bun run all`. Serve viewer: `bun run serve`.

## Filtering decisions

Both toolkits ship with many low-signal tools:
- **Google Super**: keep `important`-tagged tools **plus** every read/list verb (LIST/SEARCH/FIND/GET/FETCH) — the listers are exactly the producers we need.
- **GitHub**: drop `mcpIgnore`-tagged tools **except** when the verb is a producer (LIST/SEARCH/CREATE/INSERT/etc.). Many useful list-style producers (e.g. `LIST_GISTS_*`) are tagged `mcpIgnore` and would otherwise be lost.

Final kept counts: 320/437 Google Super, 625/867 GitHub.

## Edge extraction — three stages

### 1. Explicit mention (highest confidence — 18 edges)
Param descriptions sometimes name the producer tool directly:
> "draft_id: Must be obtained from `GMAIL_LIST_DRAFTS` or `GMAIL_CREATE_EMAIL_DRAFT`"

We regex-match UPPER_SNAKE tokens against the slug set.

### 2. Heuristic resource matching (3,196 candidate edges)
For each consumer's required ID-like input parameter:
- Strip suffixes (`_id`, `_ids`, `_name`, `_number`, etc.) to get a "param root" (e.g. `pull_number → pull`).
- Map the root to producer tools whose **resource** or description hints contain that root.
- Boost producers whose verb is `LIST/SEARCH/FIND` (universal producers).
- Apply a **canonical-producer override map** for high-frequency identifiers (`owner`, `repo`, `branch`, `calendar_id`, `pull_number`, etc.) — these would otherwise generate hundreds of edges per param. Each maps to 1–3 canonical discovery tools.

### 3. LLM refinement (2,174 final edges)
For every (consumer, param) with 2+ heuristic candidates **or** for unresolved cases, ask Claude Haiku 4.5 (via OpenRouter) to pick the producers that *genuinely* satisfy the param. The model sees the consumer's description, the param description, and the candidate slate. Strict instruction: reject candidates whose resource is a different domain even when names overlap.

The LLM's role is **pruning**, not raw generation — heuristics give recall, the LLM gives precision. Results are cached in `data/llm-cache.json` so re-runs are free.

## What this approach catches well

- Required-id chains: `LIST_X → DELETE_X`, `LIST_X → GET_X_DETAILS`, etc.
- Cross-resource dependencies: `LIST_BRANCHES → CREATE_PULL_REQUEST [head/base]`.
- Drive-file polymorphism: `FIND_FILE` produces `spreadsheet_id`, `document_id`, `presentation_id` (since they're all Drive files).
- Canonical "ambient" identifiers: `GET_AUTHENTICATED_USER` as the canonical `owner` producer for GitHub.

## Known limitations

- **GA4 / Analytics-style `name` params** (e.g. `properties/{property}/audienceLists/{id}`) are unresolved — there's no list-tool in the dataset that produces these resource paths.
- **Output schemas use `$ref` to dangling `$defs`** in the raw API response, so we can't fully traverse output types. We compensate by mining tool/param descriptions and slug structure.
- **Cross-toolkit edges are deliberately blocked** — a Gmail thread_id can't come from a GitHub tool, so the same-toolkit constraint is correct.

## Visualization

`public/index.html` uses Cytoscape.js + fcose layout. Features:
- Color by service (Gmail / Calendar / Drive / GitHub / Sheets / Docs / Slides / Maps / Meet).
- Shape by role: ellipse = producer-only, rectangle = consumer-only, hexagon = both.
- Click any node to see its dependencies (incoming) and consumers (outgoing).
- Filter by service or by edge-derivation reason (`explicit_mention`, `llm`, `resource_match`).
- Free-text search by name/slug.
