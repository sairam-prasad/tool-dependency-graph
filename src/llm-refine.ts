import { writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type { ToolProfile } from "./build-profiles.ts";
import type { Edge } from "./heuristic-edges.ts";

const DATA_DIR = join(import.meta.dir, "..", "data");
const CACHE_FILE = join(DATA_DIR, "llm-cache.json");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "anthropic/claude-haiku-4.5";

if (!OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set");
  process.exit(1);
}

type CandidateBundle = {
  consumerSlug: string;
  consumerName: string;
  consumerDescription: string;
  param: { name: string; description: string };
  candidates: Array<{ slug: string; name: string; description: string }>;
};

type LLMResult = {
  picks: string[]; // candidate slugs the model thinks satisfy this param (subset of input candidates, possibly empty)
};

const cache: Record<string, LLMResult> = existsSync(CACHE_FILE)
  ? await Bun.file(CACHE_FILE).json()
  : {};

async function llmJudge(bundle: CandidateBundle): Promise<LLMResult> {
  const cacheKey = `${bundle.consumerSlug}::${bundle.param.name}::${bundle.candidates.map((c) => c.slug).sort().join(",")}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const candidatesBlock = bundle.candidates
    .map((c, i) => `${i + 1}. ${c.slug} — ${c.name}: ${c.description.slice(0, 220)}`)
    .join("\n");

  const prompt = `You are inferring tool dependencies for an agent.

CONSUMER tool: ${bundle.consumerSlug}
Description: ${bundle.consumerDescription.slice(0, 400)}

It needs the input parameter: \`${bundle.param.name}\`
Param description: ${bundle.param.description.slice(0, 400)}

Among these CANDIDATE producer tools, which ones REALISTICALLY produce a value usable for this parameter?

${candidatesBlock}

Reply with ONLY a JSON object: {"picks": ["SLUG_1", "SLUG_2"]} listing the slugs (verbatim from the list) that genuinely produce this value. If none do, reply {"picks": []}. Pick at most 3. Be strict — do not include candidates that operate on a different resource even if names overlap.`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("LLM error:", res.status, txt.slice(0, 200));
    return { picks: [] };
  }
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  let parsed: LLMResult = { picks: [] };
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (Array.isArray(j.picks)) {
        parsed = { picks: j.picks.filter((s: any) => typeof s === "string") };
      }
    } catch {}
  }
  cache[cacheKey] = parsed;
  return parsed;
}

async function flushCache() {
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

function dedupeBy<T>(arr: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function main() {
  const profiles: ToolProfile[] = await Bun.file(join(DATA_DIR, "profiles.json")).json();
  const heuristicEdges: Edge[] = await Bun.file(join(DATA_DIR, "heuristic-edges.json")).json();
  const unresolved: Array<{ tool: string; param: string; description: string; toolkit: string }> =
    await Bun.file(join(DATA_DIR, "unresolved.json")).json();
  const bySlug = new Map(profiles.map((p) => [p.slug, p]));

  // Build the set of bundles to judge:
  //   (a) every consumer-param that has 2+ heuristic candidates → ask LLM to prune.
  //   (b) every unresolved consumer-param → ask LLM with a broad candidate slate.

  const bundles: CandidateBundle[] = [];

  // (a) Refinement: groups of edges by (to, param)
  const byKey = new Map<string, Edge[]>();
  for (const e of heuristicEdges) {
    const k = `${e.to}::${e.param}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(e);
  }
  for (const [k, edges] of byKey) {
    if (edges.length < 2) continue; // Single-candidate edges: trust the heuristic.
    const [to, param] = k.split("::");
    const consumer = bySlug.get(to);
    if (!consumer) continue;
    const paramSchema = consumer.inputs.find((i) => i.name === param);
    if (!paramSchema) continue;
    bundles.push({
      consumerSlug: to,
      consumerName: consumer.name,
      consumerDescription: consumer.description,
      param: { name: param, description: paramSchema.description },
      candidates: edges
        .map((e) => bySlug.get(e.from))
        .filter((p): p is ToolProfile => !!p)
        .map((p) => ({ slug: p.slug, name: p.name, description: p.description })),
    });
  }

  // (b) Unresolved: build broad candidates by toolkit + verb=LIST/SEARCH/FIND/CREATE/INSERT.
  const PRODUCER_VERBS = new Set(["LIST", "SEARCH", "FIND", "CREATE", "INSERT", "AUTOCOMPLETE", "LOOKUP", "QUERY", "GENERATE"]);
  const producersByToolkit = new Map<string, ToolProfile[]>();
  for (const p of profiles) {
    if (!PRODUCER_VERBS.has(p.verb)) continue;
    if (!producersByToolkit.has(p.toolkit)) producersByToolkit.set(p.toolkit, []);
    producersByToolkit.get(p.toolkit)!.push(p);
  }

  for (const u of unresolved) {
    const consumer = bySlug.get(u.tool);
    if (!consumer) continue;
    const pool = producersByToolkit.get(u.toolkit) ?? [];
    // Score producers by token overlap with the param description.
    const descLower = (u.description || "").toLowerCase();
    const paramName = u.param.toLowerCase();
    const ranked = pool
      .map((p) => {
        let score = 0;
        for (const h of p.producedHints) {
          if (h && descLower.includes(h)) score += 2;
          if (h === paramName.replace(/_id$|_ids$|_name$/, "")) score += 5;
        }
        if (descLower.includes(p.resource.toLowerCase())) score += 3;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (ranked.length === 0) continue;
    bundles.push({
      consumerSlug: u.tool,
      consumerName: consumer.name,
      consumerDescription: consumer.description,
      param: { name: u.param, description: u.description },
      candidates: ranked.map(({ p }) => ({ slug: p.slug, name: p.name, description: p.description })),
    });
  }

  console.log(`Bundles to judge: ${bundles.length}`);

  // Concurrency-limited fetch.
  const LIMIT = 8;
  const results: Array<{ bundle: CandidateBundle; result: LLMResult }> = [];
  let inFlight = 0;
  let idx = 0;
  let done = 0;
  await new Promise<void>((resolve) => {
    const launch = () => {
      while (inFlight < LIMIT && idx < bundles.length) {
        const bundle = bundles[idx++];
        inFlight++;
        llmJudge(bundle)
          .then((result) => {
            results.push({ bundle, result });
          })
          .catch((err) => console.error("judge err:", err))
          .finally(() => {
            inFlight--;
            done++;
            if (done % 25 === 0) {
              console.log(`  ${done}/${bundles.length}`);
              flushCache();
            }
            if (idx >= bundles.length && inFlight === 0) resolve();
            else launch();
          });
      }
    };
    launch();
  });
  await flushCache();

  // Build refined edges. Strategy:
  // - For (a) refinement bundles, replace the existing heuristic edges for that (to, param) with edges only to LLM picks.
  // - For (b) unresolved bundles, add new edges from LLM picks.
  const refinedByKey = new Map<string, string[]>(); // "to::param" -> picks
  for (const { bundle, result } of results) {
    refinedByKey.set(`${bundle.consumerSlug}::${bundle.param.name}`, result.picks);
  }

  const finalEdges: Edge[] = [];
  const seen = new Set<string>();
  const push = (e: Edge) => {
    const k = `${e.from}->${e.to}::${e.param}`;
    if (seen.has(k)) return;
    seen.add(k);
    finalEdges.push(e);
  };

  // Carry over heuristic edges, optionally pruned by LLM picks.
  for (const e of heuristicEdges) {
    const key = `${e.to}::${e.param}`;
    const picks = refinedByKey.get(key);
    // Always keep explicit_mention edges — these were extracted from descriptions and are high-confidence ground truth.
    if (e.reason === "explicit_mention") { push(e); continue; }
    if (picks === undefined) {
      // Single-candidate (no LLM call) — keep.
      push(e);
      continue;
    }
    if (picks.length === 0) {
      // LLM rejected all heuristic candidates for this param — drop them.
      continue;
    }
    if (picks.includes(e.from)) {
      push({ ...e, reason: "llm", confidence: 0.9 });
    }
    // else: pruned by LLM
  }
  // Add LLM-only edges from the unresolved pass.
  for (const { bundle, result } of results) {
    for (const slug of result.picks) {
      if (!bySlug.has(slug)) continue;
      if (slug === bundle.consumerSlug) continue;
      push({
        from: slug,
        to: bundle.consumerSlug,
        param: bundle.param.name,
        reason: "llm",
        confidence: 0.85,
        evidence: bundle.param.description.slice(0, 240),
      });
    }
  }

  await writeFile(join(DATA_DIR, "edges.json"), JSON.stringify(finalEdges, null, 2), "utf-8");
  const byReason: Record<string, number> = {};
  for (const e of finalEdges) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  console.log(`Final edges: ${finalEdges.length}`, byReason);
  await Bun.write(CACHE_FILE, JSON.stringify(cache, null, 2));
}

main();
