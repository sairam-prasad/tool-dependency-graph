import { writeFile } from "fs/promises";
import { join } from "path";
import type { ToolProfile } from "./build-profiles.ts";

const DATA_DIR = join(import.meta.dir, "..", "data");

export type Edge = {
  from: string;          // producer slug
  to: string;            // consumer slug
  param: string;         // the consumer's input parameter satisfied by `from`
  reason: "explicit_mention" | "id_match" | "resource_match" | "llm";
  confidence: number;    // 0..1
  evidence?: string;     // short snippet of evidence text
};

// Convert camelCase / PascalCase to snake_case so `fileId` and `file_id` normalize the same.
function toSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const ID_LIKE_SNAKE = /^([a-z][a-z0-9_]*?)(_id|_ids|_name|_number|_slug|_key|_path|_ref|_sha|_token|_url|_digest|_hash)$/;

// Map for Google Drive file IDs: spreadsheet/document/presentation are all Drive files.
const DRIVE_FILE_KIND = new Set(["spreadsheet", "document", "presentation", "doc"]);

// Names that aren't *_id but still reference a real resource. Many auto-resolve via the regex
// once we snake-case the param, but a few are pure short names with no suffix.
const NAMED_REF_PARAMS = new Set([
  // GitHub
  "owner", "repo", "branch", "head", "base", "ref", "sha", "tag",
  "username", "org", "team_slug", "enterprise", "enterprise_slug",
  "tree", "object", "license", "key", "path", "basehead", "subject_digest", "template_repo",
  // Google
  "calendar", "parent", "query", "q", "range", "setting", "name",
  "conference_record_name", "space_name",
]);

function looksLikeIdParam(p: { name: string; description: string; type: string }): boolean {
  if (p.type !== "string" && p.type !== "integer" && p.type !== "number") return false;
  const snake = toSnake(p.name);
  if (ID_LIKE_SNAKE.test(snake)) return true;
  if (snake === "id") return true;
  if (NAMED_REF_PARAMS.has(snake)) return true;
  // Description-based fallback: descriptions that explicitly say "must already exist"
  // or "use ... action to create" are clear identifiers.
  const d = p.description.toLowerCase();
  if (d.includes("must already exist") || d.includes("must be obtained") ||
      d.includes("returned by") || d.includes("retrieved by") ||
      d.includes("from a previous") || d.includes("call the") && d.includes("action")) {
    return true;
  }
  return false;
}

function findExplicitMentions(text: string, slugSet: Set<string>): string[] {
  // Match SLUG_LIKE tokens (UPPER_SNAKE) that are in our slug set.
  const found = new Set<string>();
  for (const m of text.matchAll(/[A-Z][A-Z0-9_]{4,}/g)) {
    const tok = m[0];
    if (slugSet.has(tok)) found.add(tok);
    // Sometimes descriptions say e.g. GMAIL_LIST_THREADS without the toolkit prefix.
    for (const slug of slugSet) {
      if (slug.endsWith("_" + tok) || slug.includes("_" + tok + "_") || slug.includes(tok)) {
        // Only count substantial overlaps.
        if (tok.length >= 8) found.add(slug);
      }
    }
  }
  return [...found];
}

async function main() {
  const profiles: ToolProfile[] = await Bun.file(join(DATA_DIR, "profiles.json")).json();
  const slugSet = new Set(profiles.map((p) => p.slug));
  const bySlug = new Map(profiles.map((p) => [p.slug, p]));

  // Index producers by hint token.
  const producersByHint = new Map<string, string[]>();
  for (const p of profiles) {
    for (const h of p.producedHints) {
      const k = h.toLowerCase();
      if (!producersByHint.has(k)) producersByHint.set(k, []);
      producersByHint.get(k)!.push(p.slug);
    }
  }

  const edges: Edge[] = [];
  const edgeKey = (e: Edge) => `${e.from}->${e.to}::${e.param}`;
  const seen = new Set<string>();
  const push = (e: Edge) => {
    const k = edgeKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(e);
  };

  for (const consumer of profiles) {
    for (const param of consumer.inputs) {
      if (!param.required) continue;
      if (!looksLikeIdParam(param)) continue;

      // 1. Explicit mention of another tool slug in the param description (highest confidence).
      const mentions = findExplicitMentions(param.description, slugSet);
      let explicitFound = false;
      for (const slug of mentions) {
        if (slug === consumer.slug) continue;
        const prod = bySlug.get(slug);
        if (!prod || prod.toolkit !== consumer.toolkit) continue; // same-toolkit only
        push({
          from: slug,
          to: consumer.slug,
          param: param.name,
          reason: "explicit_mention",
          confidence: 0.95,
          evidence: param.description.slice(0, 240),
        });
        explicitFound = true;
      }
      if (explicitFound) continue;

      // 2. Token-based match: param tokens vs producer hints.
      // Use a focused set of "anchor" tokens. Normalize camelCase first so `fileId` and `file_id` collapse.
      const paramSnake = toSnake(param.name);
      // Strip suffixes to get the resource root: `pull_number` → `pull`, `commit_sha` → `commit`, `file_id` → `file`.
      const paramRoot = paramSnake.replace(/_id$|_ids$|_name$|_number$|_slug$|_key$|_path$|_ref$|_sha$|_digest$|_hash$/, "");
      const anchorTokens = new Set<string>();
      if (paramRoot) anchorTokens.add(paramRoot);
      // GitHub's `owner` is fundamentally a user/org.
      if (paramRoot === "owner") { anchorTokens.add("user"); anchorTokens.add("org"); }
      if (paramRoot === "head" || paramRoot === "base") anchorTokens.add("branch");
      if (paramRoot === "sha" || paramRoot === "tree" || paramRoot === "commit" || paramRoot === "object" || paramRoot === "subject_digest") {
        anchorTokens.add("commit");
      }
      if (paramRoot === "ref") { anchorTokens.add("branch"); anchorTokens.add("tag"); }
      if (paramRoot === "tag") anchorTokens.add("tag");
      if (paramRoot === "license") anchorTokens.add("license");
      if (DRIVE_FILE_KIND.has(paramRoot)) anchorTokens.add("file");
      // For generic params, mine the description for the resource word.
      if (paramRoot === "id" || paramRoot === "" || paramRoot === "name" || paramRoot === "parent" || paramRoot === "key" || paramRoot === "path") {
        const descLower = param.description.toLowerCase();
        for (const w of ["channel", "calendar", "event", "thread", "message", "draft", "label", "file", "folder", "spreadsheet", "document", "presentation", "place", "permission", "comment", "footer", "header", "page", "issue", "pull", "branch", "ref", "commit", "repository", "repo", "user", "org", "team", "workflow", "release", "tag", "gist", "review", "deployment", "migration", "deploy_key", "license", "drive", "task", "tasklist", "audience", "property", "attestation", "code_of_conduct"]) {
          if (new RegExp("\\b" + w.replace(/_/g, "[_ ]") + "s?\\b").test(descLower)) anchorTokens.add(w);
        }
      }

      // Canonical-producer overrides for high-frequency, ambient identifiers. These params are
      // required by hundreds of tools each, but conceptually there's one canonical way to discover them.
      // Keys MUST be in snake_case (camelCase params are normalized via toSnake).
      const CANONICAL: Record<string, string[]> = {
        // GitHub ambient
        owner: ["GITHUB_GET_THE_AUTHENTICATED_USER", "GITHUB_LIST_ORGANIZATIONS_FOR_THE_AUTHENTICATED_USER"],
        repo: ["GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "GITHUB_LIST_ORGANIZATION_REPOSITORIES", "GITHUB_SEARCH_REPOSITORIES"],
        template_repo: ["GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "GITHUB_SEARCH_REPOSITORIES"],
        org: ["GITHUB_LIST_ORGANIZATIONS_FOR_THE_AUTHENTICATED_USER"],
        username: ["GITHUB_GET_THE_AUTHENTICATED_USER", "GITHUB_LIST_USERS"],
        // GitHub Git data
        branch: ["GITHUB_LIST_BRANCHES"],
        head: ["GITHUB_LIST_BRANCHES"],
        base: ["GITHUB_LIST_BRANCHES"],
        ref: ["GITHUB_LIST_BRANCHES", "GITHUB_LIST_MATCHING_REFERENCES", "GITHUB_LIST_REPOSITORY_TAGS"],
        sha: ["GITHUB_LIST_COMMITS", "GITHUB_GET_A_COMMIT"],
        commit_sha: ["GITHUB_LIST_COMMITS", "GITHUB_GET_A_COMMIT"],
        tree_sha: ["GITHUB_GET_A_TREE", "GITHUB_LIST_COMMITS"],
        tree: ["GITHUB_GET_A_TREE", "GITHUB_LIST_COMMITS"],
        object: ["GITHUB_LIST_COMMITS", "GITHUB_GET_A_TREE"],
        basehead: ["GITHUB_LIST_BRANCHES", "GITHUB_LIST_COMMITS"],
        tag: ["GITHUB_LIST_REPOSITORY_TAGS"],
        // GitHub PR/Issue
        pull_number: ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_FIND_PULL_REQUESTS"],
        issue_number: ["GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS"],
        // GitHub other resources
        gist_id: ["GITHUB_LIST_GISTS_FOR_THE_AUTHENTICATED_USER", "GITHUB_LIST_GISTS_FOR_A_USER", "GITHUB_LIST_PUBLIC_GISTS"],
        run_id: ["GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY"],
        license: ["GITHUB_LIST_COMMONLY_USED_LICENSES"],
        // Google Calendar
        rule_id: ["GOOGLESUPER_ACL_INSERT", "GOOGLESUPER_ACL_LIST"],
        calendar_id: ["GOOGLESUPER_CALENDAR_LIST_GET"],
        // Google Drive (camelCase normalized → snake)
        spreadsheet_id: ["GOOGLESUPER_SEARCH_SPREADSHEETS", "GOOGLESUPER_FIND_FILE"],
        document_id: ["GOOGLESUPER_FIND_FILE"],
        presentation_id: ["GOOGLESUPER_FIND_FILE"],
        file_id: ["GOOGLESUPER_FIND_FILE"],
        folder_id: ["GOOGLESUPER_FIND_FOLDER"],
        drive_id: ["GOOGLESUPER_FIND_FILE"],
        target_id: ["GOOGLESUPER_FIND_FILE", "GOOGLESUPER_FIND_FOLDER"],
        // Google Tasks
        tasklist_id: ["GOOGLESUPER_LIST_TASK_LISTS"],
        // Google Photos / media
        media_item_id: ["GOOGLESUPER_LIST_MEDIA_ITEMS", "GOOGLESUPER_SEARCH_MEDIA_ITEMS"],
        album_id: ["GOOGLESUPER_LIST_MEDIA_ITEMS"],
        // Google Meet / Conferences
        conference_record_id: ["GOOGLESUPER_LIST_CONFERENCE_RECORDS"],
        participant_id: ["GOOGLESUPER_LIST_PARTICIPANTS"],
        // Google Drive (children)
        parent_id: ["GOOGLESUPER_FIND_FOLDER"],
        child_id: ["GOOGLESUPER_LIST_CHILDREN_V2"],
        // Google Apps Script / Drive apps
        app_id: ["GOOGLESUPER_GET_APP"],
        // Permissions
        permission_id: ["GOOGLESUPER_LIST_PERMISSIONS"],
        // Gmail messages: there's no LIST_MESSAGES tool — messages are discovered by walking threads.
        message_id: ["GOOGLESUPER_FETCH_MESSAGE_BY_THREAD_ID"],
      };

      const canonicalKey = paramSnake;
      const canonical = CANONICAL[canonicalKey];
      if (canonical) {
        let canonicalAdded = 0;
        for (const slug of canonical) {
          if (!bySlug.has(slug) || slug === consumer.slug) continue;
          push({
            from: slug,
            to: consumer.slug,
            param: param.name,
            reason: "resource_match",
            confidence: 0.85,
            evidence: param.description.slice(0, 240),
          });
          canonicalAdded++;
        }
        if (canonicalAdded > 0) continue; // Don't pollute with the long tail.
      }

      const candidates = new Map<string, number>();
      for (const t of anchorTokens) {
        const producers = producersByHint.get(t);
        if (!producers) continue;
        for (const prodSlug of producers) {
          if (prodSlug === consumer.slug) continue;
          const prod = bySlug.get(prodSlug)!;
          if (prod.toolkit !== consumer.toolkit) continue;
          candidates.set(prodSlug, (candidates.get(prodSlug) ?? 0) + 1);
        }
      }

      // Producers should genuinely create/list — GET/FETCH that just round-trip the same id are not producers.
      const PRODUCER_VERBS = new Set(["LIST", "SEARCH", "FIND", "CREATE", "INSERT", "AUTOCOMPLETE", "LOOKUP", "QUERY", "GENERATE"]);
      const ranked = [...candidates.entries()]
        .map(([slug, score]) => {
          const prod = bySlug.get(slug)!;
          let boost = score;
          const resourceLower = prod.resource.toLowerCase();
          // Boost producers whose resource contains the param's anchor word (LIST_PULL_REQUESTS for pull_number).
          if (paramRoot && resourceLower.includes(paramRoot)) boost += 5;
          // Prefer listers as universal producers.
          if (["LIST", "SEARCH", "FIND"].includes(prod.verb)) boost += 1;
          return { slug, score: boost, prod };
        })
        .filter(({ prod }) => PRODUCER_VERBS.has(prod.verb))
        .sort((a, b) => b.score - a.score);

      // Cap candidates per param to keep the graph readable.
      const top = ranked.slice(0, 4);
      for (const c of top) {
        const resourceText = (c.prod.resource + " " + c.prod.description).toLowerCase();
        const reason: Edge["reason"] =
          paramRoot && resourceText.includes(paramRoot) ? "resource_match" : "id_match";
        push({
          from: c.slug,
          to: consumer.slug,
          param: param.name,
          reason,
          confidence: reason === "resource_match" ? 0.7 : 0.45,
          evidence: param.description.slice(0, 240),
        });
      }
    }
  }

  // Stats
  const byReason: Record<string, number> = {};
  for (const e of edges) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  console.log(`Built ${edges.length} candidate edges:`, byReason);

  await writeFile(
    join(DATA_DIR, "heuristic-edges.json"),
    JSON.stringify(edges, null, 2),
    "utf-8"
  );

  // Identify required-id params with NO candidate edge — for the LLM pass.
  const unresolved: Array<{ tool: string; param: string; description: string; toolkit: string }> = [];
  for (const consumer of profiles) {
    for (const param of consumer.inputs) {
      if (!param.required || !looksLikeIdParam(param)) continue;
      const has = edges.some((e) => e.to === consumer.slug && e.param === param.name);
      if (!has) {
        unresolved.push({
          tool: consumer.slug,
          param: param.name,
          description: param.description,
          toolkit: consumer.toolkit,
        });
      }
    }
  }
  console.log(`Unresolved required-id params: ${unresolved.length}`);
  await writeFile(
    join(DATA_DIR, "unresolved.json"),
    JSON.stringify(unresolved, null, 2),
    "utf-8"
  );
}

main();
