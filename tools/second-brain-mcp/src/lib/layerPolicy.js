/**
 * Критичность слоя конвейера → модель по умолчанию.
 *
 * Порт `src/llm/slot_policy.py` из GrowthProducer: там единицей был «слот»
 * (стадия конвейера канала), здесь — слой Promts/*.md. Смысл тот же: на
 * некритичных слоях (роутер, чистка расшифровки, NER, lint) незачем жечь
 * платную модель — туда идёт топ-1 из бесплатного каталога OpenRouter;
 * критичные слои (риски, прецеденты, прогноз, синтез консультанта, почерк)
 * остаются на платной модели.
 *
 * Конфиг: config/layer_policy.json. Fail-soft: битый/отсутствующий файл →
 * все слои non_critical с дефолтным бюджетом токенов.
 */

import fs from "node:fs";
import { repoPath } from "./runtimePaths.js";

const FALLBACK_CRITICALITY = "non_critical";
const FALLBACK_OUT_TOKENS = 800;
const FALLBACK_PAID = "anthropic/claude-opus-4.6";

export const CRITICALITIES = ["critical", "non_critical"];

/** @type {Map<string, {paidDefault: string, layers: Record<string, object>}>} */
const _cache = new Map();

function configPath() {
  return process.env.LAYER_POLICY_PATH || repoPath("config", "layer_policy.json");
}

export function loadLayerPolicy({ path = configPath(), refresh = false } = {}) {
  if (!refresh && _cache.has(path)) return _cache.get(path);
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    doc = {};
  }
  const policy = {
    paidDefault: typeof doc.paid_default === "string" ? doc.paid_default : FALLBACK_PAID,
    layers: doc.layers && typeof doc.layers === "object" ? doc.layers : {},
  };
  _cache.set(path, policy);
  return policy;
}

/** Тест-хук: сбросить кэш конфигов. */
export function resetPolicyCache() {
  _cache.clear();
}

/**
 * Слой может прийти как "04c" или "04c_precedents" — резолвим по префиксу,
 * чтобы промт не был обязан называть файл целиком.
 */
function findLayer(policy, layer) {
  const key = String(layer ?? "").trim();
  if (!key) return null;
  if (policy.layers[key]) return { key, raw: policy.layers[key] };
  const prefix = Object.keys(policy.layers).find(
    (k) => k === key || k.startsWith(`${key}_`) || k.replace(/^\d+[a-f]?_/, "") === key,
  );
  return prefix ? { key: prefix, raw: policy.layers[prefix] } : null;
}

export function resolveLayerPolicy(layer, options = {}) {
  const policy = loadLayerPolicy(options);
  const found = findLayer(policy, layer);
  const raw = found?.raw ?? {};
  return {
    layer: found?.key ?? String(layer ?? "").trim(),
    known: Boolean(found),
    criticality: CRITICALITIES.includes(raw.criticality) ? raw.criticality : FALLBACK_CRITICALITY,
    expectedOutTokens: Number.isFinite(raw.expected_out_tokens)
      ? raw.expected_out_tokens
      : FALLBACK_OUT_TOKENS,
    requires: Array.isArray(raw.requires) ? raw.requires : [],
    paidDefault: policy.paidDefault,
  };
}

export function layerCriticality(layer, options = {}) {
  return resolveLayerPolicy(layer, options).criticality;
}

export function expectedOutTokens(layer, options = {}) {
  return resolveLayerPolicy(layer, options).expectedOutTokens;
}

/**
 * Модель по умолчанию для слоя: некритичный слой + доступный бесплатный
 * топ-1 → бесплатная; иначе платный дефолт.
 */
export function defaultModelForLayer(layer, { freeTop1 = null, ...options } = {}) {
  const policy = resolveLayerPolicy(layer, options);
  if (policy.criticality === "non_critical" && freeTop1) return freeTop1;
  return policy.paidDefault;
}
