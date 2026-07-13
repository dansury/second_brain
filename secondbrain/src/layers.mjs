import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function promtsRoot() {
  return process.env.SECONDBRAIN_PROMTS_PATH || path.join(__dirname, "..", "..", "Promts");
}

/** Реестр слоёв анализа: читает frontmatter каждого Promts/*.md (ТЗ §6.2). */
export async function listLayers() {
  const root = promtsRoot();
  let files;
  try {
    files = (await fs.readdir(root)).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return [];
  }
  const layers = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(root, file), "utf8");
    const { frontmatter } = parseFrontmatter(content);
    layers.push({
      file: `Promts/${file}`,
      layer: frontmatter.layer || null,
      model_default: frontmatter.model_default || null,
      temperature: frontmatter.temperature ?? null,
      output_schema: frontmatter.output_schema || null,
    });
  }
  return layers;
}
