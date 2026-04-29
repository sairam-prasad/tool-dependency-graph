import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

type RawTool = {
  slug: string;
  name: string;
  description: string;
  inputParameters: {
    type: string;
    properties: Record<string, ParamSchema>;
    required?: string[];
  };
  outputParameters: any;
  tags?: string[];
  toolkit: { slug: string };
  isDeprecated?: boolean;
};

type ParamSchema = {
  type?: string;
  description?: string;
  title?: string;
  examples?: any[];
  default?: any;
};

export type ToolProfile = {
  slug: string;
  name: string;
  toolkit: string;
  description: string;
  verb: string;
  resource: string;
  tags: string[];
  inputs: Array<{
    name: string;
    description: string;
    required: boolean;
    type: string;
    examples: any[];
  }>;
  // Identifiers this tool likely produces (parsed from description and output property names).
  producedHints: string[];
};

const DATA_DIR = join(import.meta.dir, "..", "data");

function classifyVerb(slug: string): { verb: string; resource: string } {
  // GOOGLESUPER_GMAIL_LIST_THREADS  ->  verb=LIST, resource=THREADS (with subservice GMAIL)
  // GITHUB_LIST_REPOSITORIES          ->  verb=LIST, resource=REPOSITORIES
  const parts = slug.split("_");
  parts.shift(); // drop toolkit prefix
  const verbs = new Set([
    "LIST", "GET", "FETCH", "SEARCH", "FIND", "CREATE", "INSERT", "UPDATE",
    "DELETE", "REMOVE", "REPLY", "SEND", "EXECUTE", "RUN", "EXPORT", "IMPORT",
    "BATCH", "BULK", "ADD", "MOVE", "COPY", "PATCH", "SET", "CLEAR", "EMPTY",
    "ARCHIVE", "TRASH", "UNTRASH", "QUERY", "WATCH", "GENERATE", "VALIDATE",
    "DOWNLOAD", "UPLOAD", "CHECK", "SYNC", "RESUMABLE", "STOP", "EDIT",
    "AUTOCOMPLETE", "PARSE", "FORMAT", "GEOCODE", "GEOLOCATE", "RENDER",
    "REPLACE", "FORWARD", "MODIFY", "DUPLICATE", "PROVISION", "UPSERT",
    "MERGE", "UNMERGE", "HIDE", "UNHIDE", "AGGREGATE", "COMPUTE", "LOOKUP",
    "GRANT", "REVOKE", "ENABLE", "DISABLE", "RESTORE", "RERUN", "CANCEL",
    "REQUEST", "APPROVE", "REJECT", "CLOSE", "REOPEN", "LOCK", "UNLOCK",
    "FORK", "STAR", "UNSTAR", "FOLLOW", "UNFOLLOW", "ASSIGN", "UNASSIGN"
  ]);
  let verbIdx = parts.findIndex((p) => verbs.has(p));
  if (verbIdx === -1) verbIdx = 0;
  const verb = parts[verbIdx] ?? "OTHER";
  const resource = parts.slice(verbIdx + 1).join("_") || parts.slice(0, verbIdx).join("_") || "ITEM";
  return { verb, resource };
}

function isProducer(verb: string): boolean {
  return ["LIST", "GET", "FETCH", "SEARCH", "FIND", "CREATE", "INSERT", "GENERATE", "AUTOCOMPLETE", "LOOKUP", "QUERY", "AGGREGATE", "COMPUTE", "GEOCODE", "GEOLOCATE"].includes(verb);
}

const RESOURCE_VOCAB = [
  "thread", "message", "draft", "label", "attachment",
  "calendar", "event", "acl",
  "file", "folder", "drive", "permission", "comment",
  "spreadsheet", "sheet", "row", "column", "range", "filter", "chart", "pivot",
  "document", "doc", "footer", "header", "table", "section",
  "presentation", "slide", "page", "layout", "master",
  "place", "location", "geocode",
  "channel",
  "issue", "pull", "branch", "ref", "commit", "repository", "repo", "user", "org",
  "team", "workflow", "run", "job", "release", "tag", "gist", "comment", "review",
  "deployment", "milestone", "label", "project", "card", "column", "key", "secret",
  "fork", "star", "watcher", "collaborator", "hook", "webhook", "actions", "artifact",
  "package", "discussion", "alert", "contributor", "blob", "tree", "asset",
];

function singularize(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("zes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function expandHint(hints: Set<string>, w: string) {
  if (!w) return;
  hints.add(w);
  const sing = singularize(w);
  if (sing !== w) hints.add(sing);
  hints.add(w + "_id");
  hints.add(sing + "_id");
}

function extractProducedHints(tool: RawTool): string[] {
  const hints = new Set<string>();
  const desc = (tool.description || "").toLowerCase();
  const name = (tool.name || "").toLowerCase();

  // Collect every resource-vocab word present in the description or name (strong signal: tool talks about a thing).
  const text = name + " " + desc;
  for (const w of RESOURCE_VOCAB) {
    if (new RegExp(`\\b${w}s?\\b`).test(text)) expandHint(hints, w);
  }

  // Mine output property names (only top-level, since $defs are unresolved).
  const outProps = tool.outputParameters?.properties ?? {};
  for (const k of Object.keys(outProps)) hints.add(k);

  // Add resource-derived hints from the slug itself.
  const { verb, resource } = classifyVerb(tool.slug);
  if (isProducer(verb) && resource) {
    for (const piece of resource.toLowerCase().split("_")) {
      if (piece.length >= 3) expandHint(hints, piece);
    }
  }

  // The toolkit-level resource embedded in the slug as the second token (e.g. CALENDAR, GMAIL, SPREADSHEETS).
  const slugParts = tool.slug.split("_");
  const second = slugParts[1]?.toLowerCase();
  if (second) {
    if (RESOURCE_VOCAB.includes(second) || RESOURCE_VOCAB.includes(singularize(second))) {
      expandHint(hints, singularize(second));
    }
  }

  return [...hints].filter(Boolean);
}

const READ_VERBS = new Set(["LIST", "SEARCH", "FIND", "GET", "FETCH", "AUTOCOMPLETE", "LOOKUP", "QUERY"]);

const PRODUCER_VERBS_FOR_FILTER = new Set([
  "LIST", "SEARCH", "FIND", "CREATE", "INSERT", "GENERATE",
  "AUTOCOMPLETE", "LOOKUP", "QUERY", "GET", "FETCH",
  "FORK", "COPY", "DUPLICATE", "STAR", "ADD",
]);

function shouldKeep(tool: RawTool): boolean {
  if (tool.isDeprecated) return false;
  const tags = tool.tags || [];
  if (tags.includes("deprecated")) return false;
  const { verb } = classifyVerb(tool.slug);
  if (tool.toolkit.slug === "github") {
    // mcpIgnore-tagged tools are noise for direct exposure to LLMs, but many of them are exactly the
    // producers we need (LIST_GISTS_*, CREATE_A_GIST, etc.). Keep them only if they're producers.
    if (tags.includes("mcpIgnore") && !PRODUCER_VERBS_FOR_FILTER.has(verb)) return false;
    return true;
  }
  if (tool.toolkit.slug === "googlesuper") {
    if (tags.includes("important")) return true;
    if (READ_VERBS.has(verb)) return true;
    return false;
  }
  return true;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const profiles: ToolProfile[] = [];

  for (const toolkit of ["googlesuper", "github"] as const) {
    const raw: RawTool[] = await Bun.file(join(DATA_DIR, `${toolkit}_tools.json`)).json();
    let kept = 0;
    for (const tool of raw) {
      if (!shouldKeep(tool)) continue;
      kept++;
      const { verb, resource } = classifyVerb(tool.slug);
      const inputProps = tool.inputParameters?.properties ?? {};
      const required = new Set(tool.inputParameters?.required ?? []);
      const inputs = Object.entries(inputProps).map(([name, schema]) => ({
        name,
        description: schema.description ?? "",
        required: required.has(name),
        type: schema.type ?? "unknown",
        examples: schema.examples ?? [],
      }));
      profiles.push({
        slug: tool.slug,
        name: tool.name,
        toolkit: tool.toolkit.slug,
        description: tool.description,
        verb,
        resource,
        tags: tool.tags ?? [],
        inputs,
        producedHints: extractProducedHints(tool),
      });
    }
    console.log(`${toolkit}: kept ${kept}/${raw.length}`);
  }

  await writeFile(
    join(DATA_DIR, "profiles.json"),
    JSON.stringify(profiles, null, 2),
    "utf-8"
  );
  console.log(`Wrote ${profiles.length} profiles → data/profiles.json`);
}

main();
