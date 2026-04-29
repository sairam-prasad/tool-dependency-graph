import { writeFile } from "fs/promises";
import { join } from "path";
import type { ToolProfile } from "./build-profiles.ts";
import type { Edge } from "./heuristic-edges.ts";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

type Node = {
  id: string;
  label: string;
  toolkit: string;
  service: string;
  verb: string;
  description: string;
  isProducer: boolean;
  isConsumer: boolean;
};

function serviceFor(profile: ToolProfile): string {
  // For googlesuper, infer the sub-service from tags or slug.
  if (profile.toolkit === "github") return "github";
  const tags = profile.tags.map((t) => t.toLowerCase());
  for (const t of ["gmail", "calendar", "drive", "googlesheets", "googledocs", "googleslides", "googleads", "googleanalytics", "googlemaps", "googlemeet", "googleforms", "googlebusinessprofile"]) {
    if (tags.includes(t)) return t;
  }
  // Fallback: parse from slug for known sub-services.
  const slug = profile.slug;
  const map: Record<string, string> = {
    GMAIL: "gmail", CALENDAR: "calendar", CALENDARS: "calendar", ACL: "calendar",
    EVENTS: "calendar", EVENT: "calendar", FREE: "calendar",
    DRIVE: "drive", FILE: "drive", FILES: "drive", FOLDER: "drive",
    SPREADSHEET: "googlesheets", SPREADSHEETS: "googlesheets", SHEET: "googlesheets",
    DOCUMENT: "googledocs", DOCS: "googledocs",
    PRESENTATION: "googleslides", PRESENTATIONS: "googleslides", SLIDES: "googleslides",
    MAPS: "googlemaps", PLACE: "googlemaps", GEOCODE: "googlemaps", GEOLOCATE: "googlemaps", AUTOCOMPLETE: "googlemaps", DISTANCE: "googlemaps",
    MEET: "googlemeet", CONFERENCE: "googlemeet", PARTICIPANT: "googlemeet", TRANSCRIPT: "googlemeet", SPACE: "googlemeet",
  };
  for (const part of slug.split("_")) {
    if (map[part]) return map[part];
  }
  return "googlesuper";
}

async function main() {
  const profiles: ToolProfile[] = await Bun.file(join(DATA_DIR, "profiles.json")).json();
  const edges: Edge[] = await Bun.file(join(DATA_DIR, "edges.json")).json();

  const producerSet = new Set(edges.map((e) => e.from));
  const consumerSet = new Set(edges.map((e) => e.to));

  const nodes: Node[] = profiles.map((p) => ({
    id: p.slug,
    label: p.name || p.slug,
    toolkit: p.toolkit,
    service: serviceFor(p),
    verb: p.verb,
    description: p.description,
    isProducer: producerSet.has(p.slug),
    isConsumer: consumerSet.has(p.slug),
  }));

  // Drop nodes with no edges to keep the visualization focused.
  const referenced = new Set([...producerSet, ...consumerSet]);
  const filteredNodes = nodes.filter((n) => referenced.has(n.id));

  const graph = {
    meta: {
      totalTools: profiles.length,
      visualizedTools: filteredNodes.length,
      totalEdges: edges.length,
      services: [...new Set(filteredNodes.map((n) => n.service))].sort(),
    },
    nodes: filteredNodes,
    edges: edges.map((e) => ({
      source: e.from,
      target: e.to,
      param: e.param,
      reason: e.reason,
      confidence: e.confidence,
      evidence: e.evidence,
    })),
  };

  await writeFile(join(DATA_DIR, "graph.json"), JSON.stringify(graph, null, 2), "utf-8");
  // Also write into public/ for the static viewer.
  await Bun.write(join(PUBLIC_DIR, "graph.json"), JSON.stringify(graph));
  console.log(`Graph: ${filteredNodes.length} nodes, ${edges.length} edges`);
  console.log(`Services: ${graph.meta.services.join(", ")}`);
}

main();
