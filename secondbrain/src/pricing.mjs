import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = path.join(__dirname, "..", "pricing.json");

let cache = null;

async function load() {
  if (cache) return cache;
  const raw = await fs.readFile(PRICING_PATH, "utf8");
  cache = JSON.parse(raw);
  return cache;
}

/** Модели провайдера, отсортированные по возрастанию цены (ТЗ §5). */
export async function modelPrices(provider) {
  const data = await load();
  const list = data[provider];
  if (!list) {
    return { provider, models: [], known_providers: Object.keys(data).filter((k) => k !== "_meta") };
  }
  const sorted = [...list].sort((a, b) => a.prompt_usd_per_1k - b.prompt_usd_per_1k);
  return { provider, models: sorted, note: data._meta?.note };
}
