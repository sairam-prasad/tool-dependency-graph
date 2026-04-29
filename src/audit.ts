// Hand-audit: assert key dependencies match expectations.
// Run with: ./.venv/bin/bun run src/audit.ts
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");

type Edge = { from: string; to: string; param: string; reason: string };

const edges: Edge[] = await Bun.file(join(DATA_DIR, "edges.json")).json();
const profiles: any[] = await Bun.file(join(DATA_DIR, "profiles.json")).json();
const bySlug = new Map(profiles.map((p) => [p.slug, p]));

type Check = {
  consumer: string;
  param: string;
  // Producer match: string → exact slug, RegExp → match against producer slug.
  expected: string | RegExp | "any-producer-of" | "none";
  // For "any-producer-of", the expected is a topic word; we accept any producer whose slug contains it.
  topic?: string;
  description: string;
};

const checks: Check[] = [
  // ----- Canonical README example -----
  { consumer: "GOOGLESUPER_REPLY_TO_THREAD", param: "thread_id", expected: "GOOGLESUPER_LIST_THREADS", description: "Reply needs thread_id from list_threads (README example)" },

  // ----- Gmail -----
  { consumer: "GOOGLESUPER_DELETE_THREAD", param: "id", expected: "GOOGLESUPER_LIST_THREADS", description: "Delete thread needs id from list_threads" },
  { consumer: "GOOGLESUPER_DELETE_DRAFT", param: "draft_id", expected: /GOOGLESUPER_(LIST_DRAFTS|CREATE_EMAIL_DRAFT)/, description: "Delete draft needs id from list/create draft" },
  { consumer: "GOOGLESUPER_DELETE_MESSAGE", param: "message_id", expected: "any-producer-of", topic: "MESSAGE", description: "Delete message needs message_id" },
  { consumer: "GOOGLESUPER_MOVE_THREAD_TO_TRASH", param: "thread_id", expected: "GOOGLESUPER_LIST_THREADS", description: "Trash thread needs thread_id" },

  // ----- Calendar -----
  { consumer: "GOOGLESUPER_ACL_DELETE", param: "calendar_id", expected: "GOOGLESUPER_CALENDAR_LIST_GET", description: "ACL delete needs calendar_id" },
  { consumer: "GOOGLESUPER_ACL_DELETE", param: "rule_id", expected: /GOOGLESUPER_ACL_(LIST|INSERT)/, description: "ACL delete needs rule_id" },
  { consumer: "GOOGLESUPER_DELETE_EVENT", param: "event_id", expected: "any-producer-of", topic: "EVENT", description: "Delete event needs event_id" },

  // ----- Drive (camelCase + snake_case) -----
  { consumer: "GOOGLESUPER_DOWNLOAD_FILE", param: "fileId", expected: "GOOGLESUPER_FIND_FILE", description: "Download file needs fileId (camelCase)" },
  { consumer: "GOOGLESUPER_COPY_DOCUMENT", param: "document_id", expected: "GOOGLESUPER_FIND_FILE", description: "Copy doc needs document_id" },
  { consumer: "GOOGLESUPER_DELETE_PERMISSION", param: "file_id", expected: "GOOGLESUPER_FIND_FILE", description: "Delete permission needs file_id" },
  { consumer: "GOOGLESUPER_DELETE_PERMISSION", param: "permission_id", expected: /GOOGLESUPER_(LIST_PERMISSIONS|CREATE_PERMISSION)/, description: "Delete permission needs permission_id" },

  // ----- Sheets (camelCase) -----
  { consumer: "GOOGLESUPER_BATCH_GET", param: "spreadsheet_id", expected: /GOOGLESUPER_(SEARCH_SPREADSHEETS|FIND_FILE)/, description: "Batch get needs spreadsheet_id" },
  { consumer: "GOOGLESUPER_DELETE_SHEET", param: "spreadsheetId", expected: /GOOGLESUPER_(SEARCH_SPREADSHEETS|FIND_FILE)/, description: "Delete sheet needs spreadsheetId (camelCase)" },

  // ----- Docs -----
  { consumer: "GOOGLESUPER_DELETE_FOOTER", param: "footer_id", expected: "GOOGLESUPER_CREATE_FOOTER", description: "Delete footer needs footer_id from create_footer" },
  { consumer: "GOOGLESUPER_DELETE_FOOTER", param: "document_id", expected: "GOOGLESUPER_FIND_FILE", description: "Delete footer needs document_id" },

  // ----- Tasks -----
  { consumer: "GOOGLESUPER_GET_TASK_LIST", param: "tasklist_id", expected: "GOOGLESUPER_LIST_TASK_LISTS", description: "Get tasklist needs tasklist_id" },

  // ----- GitHub canonical ambient -----
  { consumer: "GITHUB_CREATE_A_PULL_REQUEST", param: "repo", expected: /GITHUB_(LIST|SEARCH)_REPOSITORIES/, description: "Create PR needs repo" },
  { consumer: "GITHUB_CREATE_A_PULL_REQUEST", param: "owner", expected: /GITHUB_(GET_THE_AUTHENTICATED_USER|LIST_ORGANIZATIONS)/, description: "Create PR needs owner" },
  { consumer: "GITHUB_CREATE_A_PULL_REQUEST", param: "head", expected: "GITHUB_LIST_BRANCHES", description: "Create PR needs head branch" },
  { consumer: "GITHUB_CREATE_A_PULL_REQUEST", param: "base", expected: "GITHUB_LIST_BRANCHES", description: "Create PR needs base branch" },

  // ----- GitHub PR/Issue/Gist -----
  { consumer: "GITHUB_MERGE_A_PULL_REQUEST", param: "pull_number", expected: /GITHUB_(LIST_PULL_REQUESTS|FIND_PULL_REQUESTS)/, description: "Merge PR needs pull_number" },
  { consumer: "GITHUB_DELETE_GIST", param: "gist_id", expected: /GITHUB_LIST_GISTS/, description: "Delete gist needs gist_id" },
  { consumer: "GITHUB_FORK_GIST", param: "gist_id", expected: /GITHUB_LIST_GISTS/, description: "Fork gist needs gist_id" },

  // ----- GitHub Git data (the cases user asked about) -----
  { consumer: "GITHUB_UPDATE_A_REFERENCE", param: "ref", expected: /GITHUB_(LIST_BRANCHES|LIST_MATCHING_REFERENCES|LIST_REPOSITORY_TAGS)/, description: "Update ref needs ref name (user-flagged)" },
  { consumer: "GITHUB_UPDATE_A_REFERENCE", param: "sha", expected: /GITHUB_(LIST_COMMITS|GET_A_COMMIT)/, description: "Update ref needs sha (user-flagged)" },
  { consumer: "GITHUB_UPDATE_A_REFERENCE", param: "repo", expected: /GITHUB_(LIST|SEARCH)_REPOSITORIES/, description: "Update ref needs repo" },
  { consumer: "GITHUB_CREATE_A_COMMIT", param: "tree", expected: /GITHUB_(GET_A_TREE|LIST_COMMITS)/, description: "Create commit needs tree sha" },
  { consumer: "GITHUB_DELETE_A_REFERENCE", param: "ref", expected: /GITHUB_(LIST_BRANCHES|LIST_MATCHING_REFERENCES|LIST_REPOSITORY_TAGS)/, description: "Delete ref needs ref" },

  // ----- GitHub: pure-search has no upstream -----
  { consumer: "GITHUB_SEARCH_REPOSITORIES", param: "q", expected: "none", description: "Search query is user-supplied (no upstream)" },
  { consumer: "GITHUB_SEARCH_CODE", param: "q", expected: "none", description: "Code search query is user-supplied" },
];

let passed = 0;
let failed = 0;
const failures: Array<{ check: Check; got: Edge[] }> = [];

for (const check of checks) {
  const consumer = bySlug.get(check.consumer);
  if (!consumer) {
    console.log(`SKIP  ${check.consumer} — tool not in profiles`);
    continue;
  }
  const incoming = edges.filter((e) => e.to === check.consumer && e.param === check.param);

  let ok = false;
  if (check.expected === "none") {
    ok = incoming.length === 0;
  } else if (check.expected === "any-producer-of") {
    const topic = check.topic!.toLowerCase();
    ok = incoming.some((e) => e.from.toLowerCase().includes(topic));
  } else if (check.expected instanceof RegExp) {
    ok = incoming.some((e) => (check.expected as RegExp).test(e.from));
  } else {
    ok = incoming.some((e) => e.from === check.expected);
  }

  if (ok) {
    passed++;
    console.log(`PASS  ${check.consumer}.${check.param} — ${check.description}`);
  } else {
    failed++;
    failures.push({ check, got: incoming });
    console.log(`FAIL  ${check.consumer}.${check.param} — ${check.description}`);
    console.log(`      expected: ${check.expected instanceof RegExp ? check.expected.source : check.expected}${check.topic ? ` (topic="${check.topic}")` : ""}`);
    console.log(`      got: ${incoming.length === 0 ? "(no edges)" : incoming.map((e) => `${e.from} (${e.reason})`).join(", ")}`);
  }
}

console.log("");
console.log(`SUMMARY: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log("");
  console.log("Failures:");
  for (const { check } of failures) {
    console.log(`  - ${check.consumer}.${check.param}: ${check.description}`);
  }
  process.exit(1);
}
