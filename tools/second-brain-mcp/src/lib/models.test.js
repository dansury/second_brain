import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resetCatalogCache } from "./openrouter.js";
import { loadFreeModels, refreshFreeModels, freeTop1, filterByModalities, SHIR_MAN_URL } from "./freeCatalog.js";
import { listModelsByPrice, listFreeModels, recommendModelForLayer } from "./models.js";
import { resolveLayerPolicy, defaultModelForLayer, resetPolicyCache } from "./layerPolicy.js";
import { estimateCost, renderCostCard, estimatePromptTokens, resetFxCache } from "./cost.js";

const CATALOG = {
  data: [
    {
      id: "deepseek/deepseek-r1:free",
      name: "DeepSeek R1 (free)",
      pricing: { prompt: "0", completion: "0" },
      context_length: 64000,
      architecture: { input_modalities: ["text"] },
    },
    {
      id: "google/gemini-3-flash:free",
      name: "Gemini 3 Flash (free)",
      pricing: { prompt: "0", completion: "0" },
      context_length: 1000000,
      architecture: { input_modalities: ["text", "image"] },
    },
    {
      id: "openai/gpt-4o-mini",
      name: "GPT-4o mini",
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
      context_length: 128000,
      architecture: { input_modalities: ["text", "image"] },
    },
    {
      id: "anthropic/claude-opus-4.6",
      name: "Claude Opus 4.6",
      pricing: { prompt: "0.000005", completion: "0.000025" },
      context_length: 200000,
      architecture: { input_modalities: ["text", "image"] },
    },
  ],
};

const SHIR_MAN = {
  models: [
    { id: "google/gemini-3-flash", name: "Gemini 3 Flash", daily_quota: 1000 },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1", daily_quota: 50 },
  ],
};

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** fetch-дубль: OpenRouter и shir-man отвечают, счётчик вызовов наружу. */
function makeFetch({ openrouter = ok(CATALOG), shirman = ok(SHIR_MAN) } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (String(url).startsWith(SHIR_MAN_URL)) return shirman;
    return openrouter;
  };
  impl.calls = calls;
  return impl;
}

let tmpDir;
let cachePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-models-"));
  cachePath = path.join(tmpDir, "free_models.json");
  process.env.FREE_MODELS_CACHE = cachePath;
  process.env.SECOND_BRAIN_DIR = path.resolve(new URL("../../../..", import.meta.url).pathname);
  resetCatalogCache();
  resetPolicyCache();
  resetFxCache();
});

afterAll(async () => {
  delete process.env.FREE_MODELS_CACHE;
});

describe("free catalog", () => {
  test("keeps only zero-price OpenRouter models and ranks them by shir-man order", async () => {
    const models = await refreshFreeModels({ fetchImpl: makeFetch(), path: cachePath });
    expect(models.map((m) => m.id)).toEqual([
      "google/gemini-3-flash:free",
      "deepseek/deepseek-r1:free",
    ]);
    expect(models[0].dailyQuota).toBe(1000);
  });

  test("writes the cache and serves it without refetching while fresh", async () => {
    const fetchImpl = makeFetch();
    await refreshFreeModels({ fetchImpl, path: cachePath });
    const before = fetchImpl.calls.length;

    const cached = await loadFreeModels({ fetchImpl, path: cachePath });
    expect(cached).toHaveLength(2);
    expect(fetchImpl.calls.length).toBe(before);
  });

  test("falls back to a stale cache when OpenRouter is down", async () => {
    await refreshFreeModels({ fetchImpl: makeFetch(), path: cachePath });
    resetCatalogCache();

    const down = makeFetch({ openrouter: { ok: false, status: 503, json: async () => ({}) } });
    const models = await refreshFreeModels({ fetchImpl: down, path: cachePath });
    expect(models.map((m) => m.id)).toContain("google/gemini-3-flash:free");
  });

  test("survives shir-man being unavailable — quota is enrichment only", async () => {
    const impl = makeFetch({ shirman: { ok: false, status: 500, json: async () => ({}) } });
    const models = await refreshFreeModels({ fetchImpl: impl, path: cachePath });
    expect(models).toHaveLength(2);
    // без рейтинга — сортировка по контексту
    expect(models[0].id).toBe("google/gemini-3-flash:free");
  });

  test("freeTop1 respects required modalities", async () => {
    const fetchImpl = makeFetch();
    expect(await freeTop1({ fetchImpl, path: cachePath })).toBe("google/gemini-3-flash:free");
    expect(
      filterByModalities(await loadFreeModels({ fetchImpl, path: cachePath }), ["image"]).map((m) => m.id),
    ).toEqual(["google/gemini-3-flash:free"]);
  });
});

describe("listModelsByPrice", () => {
  test("free first, then ascending prompt price", async () => {
    const result = await listModelsByPrice({ fetchImpl: makeFetch() });
    expect(result.models.map((m) => m.id)).toEqual([
      "deepseek/deepseek-r1:free",
      "google/gemini-3-flash:free",
      "openai/gpt-4o-mini",
      "anthropic/claude-opus-4.6",
    ]);
    expect(result.models[0].isFree).toBe(true);
  });

  test("freeOnly drops paid models", async () => {
    const result = await listModelsByPrice({ fetchImpl: makeFetch(), freeOnly: true });
    expect(result.models.every((m) => m.isFree)).toBe(true);
  });

  test("non-openrouter provider returns the note, not an error", async () => {
    const result = await listModelsByPrice({ provider: "yandex", fetchImpl: makeFetch() });
    expect(result.models).toEqual([]);
    expect(result.note).toContain("openrouter");
  });
});

describe("layer policy", () => {
  test("short layer aliases resolve to the full entry", () => {
    expect(resolveLayerPolicy("04c").layer).toBe("04c_precedents");
    expect(resolveLayerPolicy("04c_precedents").criticality).toBe("critical");
  });

  test("unknown layer is non-critical with a default budget", () => {
    const policy = resolveLayerPolicy("42_nonexistent");
    expect(policy.known).toBe(false);
    expect(policy.criticality).toBe("non_critical");
    expect(policy.expectedOutTokens).toBe(800);
  });

  test("non-critical layer takes the free model, critical keeps the paid default", () => {
    expect(defaultModelForLayer("00_router", { freeTop1: "free/model" })).toBe("free/model");
    expect(defaultModelForLayer("04e", { freeTop1: "free/model" })).toBe("anthropic/claude-opus-4.6");
  });

  test("no free catalog → paid default even on a non-critical layer", () => {
    expect(defaultModelForLayer("00_router", { freeTop1: null })).toBe("anthropic/claude-opus-4.6");
  });
});

describe("recommendModelForLayer", () => {
  test("non-critical layer lands on the top free model", async () => {
    const rec = await recommendModelForLayer({ layer: "01_transcription_cleanup", fetchImpl: makeFetch() });
    expect(rec.tier).toBe("free");
    expect(rec.model).toBe("google/gemini-3-flash:free");
  });

  test("critical layer stays paid and never touches the free catalog", async () => {
    const fetchImpl = makeFetch();
    const rec = await recommendModelForLayer({ layer: "04d", fetchImpl });
    expect(rec.tier).toBe("paid");
    expect(rec.model).toBe("anthropic/claude-opus-4.6");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("vision layer only gets a free model that accepts images", async () => {
    const rec = await recommendModelForLayer({ layer: "06_photo_people", fetchImpl: makeFetch() });
    expect(rec.requires).toEqual(["image"]);
    expect(rec.model).toBe("google/gemini-3-flash:free");
  });
});

describe("cost", () => {
  test("paid model priced per 1M tokens against the layer budget", async () => {
    const estimate = await estimateCost({
      model: "anthropic/claude-opus-4.6",
      layer: "04e_consultant_synthesis",
      promptTokens: 2000,
      fetchImpl: makeFetch(),
    });
    // 2000/1M * $5 + 1200/1M * $25 = 0.01 + 0.03
    expect(estimate.totalUsd).toBeCloseTo(0.04, 6);
    expect(estimate.totalRub).toBeCloseTo(3.6, 3);
    expect(estimate.tier).toBe("paid");
    expect(renderCostCard(estimate)).toContain("💳");
  });

  test("free model costs nothing and renders the free card", async () => {
    const estimate = await estimateCost({
      model: "deepseek/deepseek-r1:free",
      layer: "00_router",
      promptTokens: 5000,
      fetchImpl: makeFetch(),
    });
    expect(estimate.tier).toBe("free");
    expect(estimate.totalUsd).toBe(0);
    expect(renderCostCard(estimate)).toContain("🆓");
  });

  test("unknown model falls back to the priciest known model with a warning", async () => {
    const estimate = await estimateCost({
      model: "nobody/unknown",
      promptTokens: 1000,
      fetchImpl: makeFetch(),
    });
    expect(estimate.warnings).toContain("unknown_model:nobody/unknown");
    expect(estimate.inPricePerMTokUsd).toBeCloseTo(5, 6);
  });

  test("promptText is converted at ~4 chars per token", async () => {
    expect(estimatePromptTokens("a".repeat(400))).toBe(100);
    const estimate = await estimateCost({
      model: "openai/gpt-4o-mini",
      promptText: "a".repeat(400),
      fetchImpl: makeFetch(),
    });
    expect(estimate.promptTokens).toBe(100);
    expect(estimate.warnings).not.toContain("prompt_tokens_default");
  });
});

describe("cost when the catalog is unreachable", () => {
  test("does not claim a paid model is free — card says the price is unknown", async () => {
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const estimate = await estimateCost({ model: "anthropic/claude-opus-4.6", fetchImpl: down });
    expect(estimate.priceUnknown).toBe(true);
    expect(renderCostCard(estimate)).toContain("неизвестна");
    expect(renderCostCard(estimate)).not.toContain("$0.0000");
  });
});
