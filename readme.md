Tool Dependency Graph
A directed dependency graph for Composio's Google Super and GitHub toolkits. Each edge means "to call tool B, an agent must first call tool A to obtain a required input." For example: GMAIL_LIST_THREADS → GMAIL_REPLY_TO_THREAD (the latter needs a thread_id).

Final graph: 807 tools, 2,605 edges spanning 10 services (Gmail, Calendar, Drive, Sheets, Docs, Slides, Maps, Meet, Tasks, GitHub).

Why this exists
When an agent wants to call a Composio tool, it often can't — because that tool needs an ID, slug, or reference the agent doesn't have yet. The agent has two options: ask the user, or call another tool first to get it. This graph encodes the second option: for every required input across 1,300+ tools, it tells you which upstream tools produce that value.

Quick view

bun run serve
# open http://127.0.0.1:8765
The interactive viewer lets you click any node to see its dependencies and downstream consumers, filter by service, and search by tool name.

How it works
A 5-stage pipeline:


fetch-tools.ts     → raw JSON for both toolkits
build-profiles.ts  → filter, classify verb/resource, extract producer hints
heuristic-edges.ts → deterministic candidate edges (resource matching + canonical overrides)
llm-refine.ts      → Claude Haiku 4.5 judges ambiguous candidates via OpenRouter
assemble-graph.ts  → final nodes + edges for the viewer
Run end-to-end: bun run all.

Stage details
1. Filtering. Tools with mcpIgnore are skipped unless they're producers (LIST/SEARCH/CREATE) — many useful list-style tools are tagged mcpIgnore and would otherwise be lost. Google Super tools are kept if important-tagged or if they're a read-style verb. Final kept count: 320 Google Super, 625 GitHub.

2. Heuristic edges (precision-first). For each consumer's required ID-like input:

Normalize the param name to snake_case (so fileId and file_id collapse).
Strip the suffix to get the resource root (pull_number → pull).
Find producers whose resource or production hints contain that root.
Apply canonical-producer overrides for high-frequency identifiers (owner, repo, branch, calendar_id, pull_number, ref, sha, etc.) — without these, every consumer would point at every list-style tool, producing thousands of low-value edges.
3. LLM refinement (recall-with-precision). For every (consumer, param) with 2+ heuristic candidates or no candidates at all, Claude Haiku 4.5 sees the consumer description, param description, and candidate slate, and picks the producers that genuinely satisfy the param. Strict instruction to reject candidates whose resource is a different domain even when names overlap. Results cached in data/llm-cache.json.

4. Visualization. Cytoscape.js + fcose layout. Color by service, shape by role (producer/consumer/both), interactive node detail panel.

Quality gate
src/audit.ts runs 31 hand-verified test cases covering the canonical example from the task spec, every major resource type in both toolkits, camelCase vs snake_case parameters, and edge cases like search tools that have no upstream.


$ bun run src/audit.ts
PASS  GOOGLESUPER_REPLY_TO_THREAD.thread_id — Reply needs thread_id from list_threads
PASS  GITHUB_UPDATE_A_REFERENCE.ref → LIST_BRANCHES
PASS  GITHUB_UPDATE_A_REFERENCE.sha → LIST_COMMITS
PASS  GITHUB_SEARCH_REPOSITORIES.q → (no edges, correctly user-supplied)
... (28 more)
SUMMARY: 31/31 passed
Coverage: 90% of Google Super and 94% of GitHub required ID-like parameters have inferred producers. The remaining gap is a property of the dataset itself — Google Analytics 4 resource names like properties/{propertyId}/audienceLists/{id} are user-supplied with no list-tool to discover them.

Setup

# 1. Get a Composio API key from https://platform.composio.dev
# 2. Bootstrap .env (gives you the OpenRouter key too):
COMPOSIO_API_KEY=ak_... sh scaffold.sh

# 3. Install deps:
bun install

# 4. Run the full pipeline:
bun run all

# 5. Serve the viewer:
bun run serve
Project layout

src/
  fetch-tools.ts       — pull raw tool JSON from Composio
  build-profiles.ts    — extract producer/consumer profiles
  heuristic-edges.ts   — deterministic edge generation
  llm-refine.ts        — LLM-based candidate pruning
  assemble-graph.ts    — final graph for the viewer
  audit.ts             — 31-case verification suite
public/
  index.html           — interactive Cytoscape.js viewer
  graph.json           — final graph (nodes + edges)
data/
  *_tools.json         — raw API responses (cached)
  profiles.json        — extracted tool profiles
  edges.json           — final dependency edges with confidence + reason
  llm-cache.json       — LLM judge results (cached for repeatable runs)
APPROACH.md            — extended methodology notes
Edge schema

{
  "source": "GOOGLESUPER_LIST_THREADS",
  "target": "GOOGLESUPER_REPLY_TO_THREAD",
  "param": "thread_id",
  "reason": "llm",
  "confidence": 0.9,
  "evidence": "Identifier of the Gmail thread for the reply..."
}
reason is one of:

explicit_mention (0.95) — producer named verbatim in the consumer's param description
llm (0.85–0.9) — heuristic candidate validated by Claude Haiku 4.5
resource_match (0.7–0.85) — canonical-producer override or strong heuristic match
Known limitations
GA4/Analytics resource paths (e.g. properties/{property}/...) — no list-tool exists to discover them; the user supplies these directly.
Output schemas use $ref to dangling $defs in the raw API responses, so we can't fully traverse output types. We compensate by mining tool descriptions, slug structure, and the names of producers' top-level output properties.
Cross-toolkit edges are blocked — a Gmail thread_id can't be produced by a GitHub tool. Same-toolkit constraint is correct by design.
Stack
TypeScript on Bun, Composio Core SDK, OpenRouter (Claude Haiku 4.5), Cytoscape.js + fcose layout for visualization.
