import { Composio } from "@composio/core";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const composio = new Composio();

const OUT_DIR = join(import.meta.dir, "..", "data");
await mkdir(OUT_DIR, { recursive: true });

const toolkits = ["googlesuper", "github"] as const;

for (const toolkit of toolkits) {
  console.log(`Fetching tools for ${toolkit}...`);
  const tools = await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: 1000,
  });
  const outPath = join(OUT_DIR, `${toolkit}_tools.json`);
  await writeFile(outPath, JSON.stringify(tools, null, 2), "utf-8");
  console.log(`  ${tools.length} tools → ${outPath}`);
}
