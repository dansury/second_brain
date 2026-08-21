/**
 * Оценка стоимости одного вызова LLM + карточка цены.
 *
 * Порт `src/llm/cost.py` и `src/llm/fx.py` из GrowthProducer. Отличие:
 * цены берутся не из committed-семени `config/model_prices.json`, а из живого
 * каталога OpenRouter (`openrouter.js`) — у second_brain уже есть ключ.
 * Курс USD→RUB — `config/fx.json` (сид, правится вручную), фолбэк 90.
 */

import fs from "node:fs";
import { fetchCatalog } from "./openrouter.js";
import { expectedOutTokens } from "./layerPolicy.js";
import { repoPath } from "./runtimePaths.js";

const FALLBACK_USDRUB = 90.0;
const DEFAULT_PROMPT_TOKENS = 1000;
const CHARS_PER_TOKEN = 4;

const _fxCache = new Map();

function fxPath() {
  return process.env.FX_PATH || repoPath("config", "fx.json");
}

export function loadFx({ path = fxPath(), refresh = false } = {}) {
  if (!refresh && _fxCache.has(path)) return _fxCache.get(path);
  let rate = FALLBACK_USDRUB;
  let updated = null;
  try {
    const doc = JSON.parse(fs.readFileSync(path, "utf8"));
    const value = Number(doc?.USDRUB ?? doc?.usd_rub);
    if (Number.isFinite(value) && value > 0) rate = value;
    if (typeof doc?.updated === "string") updated = doc.updated;
  } catch {
    /* фолбэк на константу */
  }
  const fx = { usdRub: rate, updated };
  _fxCache.set(path, fx);
  return fx;
}

/** Тест-хук: сбросить кэш курса. */
export function resetFxCache() {
  _fxCache.clear();
}

/** Дешёвая эвристика: ~4 символа на токен. */
export function estimatePromptTokens(text) {
  return Math.max(1, Math.floor(String(text ?? "").length / CHARS_PER_TOKEN));
}

/**
 * Стоимость вызова (model, layer). Неизвестная модель не роняет флоу:
 * цена берётся по самой дорогой известной модели и в ответе появляется
 * warning — как в GrowthProducer, чтобы гейт всегда мог показать карточку.
 */
export async function estimateCost({
  model,
  layer = null,
  promptTokens = null,
  promptText = null,
  outTokens = null,
  fetchImpl = fetch,
} = {}) {
  if (!model) throw new Error("estimate_cost: model обязателен");

  const { models, error } = await fetchCatalog({ fetchImpl });
  const warnings = [];
  if (error) warnings.push(`catalog:${error}`);

  const known = models.find((m) => m.id === model);
  let inPrice = 0;
  let outPrice = 0;
  let tier = "paid";

  if (known) {
    inPrice = known.promptPricePerMTok ?? 0;
    outPrice = known.completionPricePerMTok ?? 0;
    tier = known.isFree ? "free" : "paid";
  } else {
    const priced = models.filter((m) => Number.isFinite(m.promptPricePerMTok));
    const worst = priced.sort(
      (a, b) =>
        (b.promptPricePerMTok ?? 0) + (b.completionPricePerMTok ?? 0) -
        ((a.promptPricePerMTok ?? 0) + (a.completionPricePerMTok ?? 0)),
    )[0];
    inPrice = worst?.promptPricePerMTok ?? 0;
    outPrice = worst?.completionPricePerMTok ?? 0;
    warnings.push(`unknown_model:${model}`);
    // Каталога нет вовсе — считать не по чему. Нулевая цена в карточке была бы
    // хуже честного «не знаю»: пользователь решит, что вызов бесплатный.
    if (!worst) warnings.push("price_unknown");
  }

  let inTokens = promptTokens;
  if (inTokens === null && promptText !== null) inTokens = estimatePromptTokens(promptText);
  if (inTokens === null) {
    inTokens = DEFAULT_PROMPT_TOKENS;
    warnings.push("prompt_tokens_default");
  }
  inTokens = Math.max(0, inTokens);

  const expectedOut = Number.isFinite(outTokens)
    ? outTokens
    : layer
      ? expectedOutTokens(layer)
      : 800;

  const totalUsd = (inTokens / 1_000_000) * inPrice + (expectedOut / 1_000_000) * outPrice;
  const fx = loadFx();

  return {
    model,
    layer,
    tier,
    promptTokens: inTokens,
    expectedOutTokens: expectedOut,
    inPricePerMTokUsd: inPrice,
    outPricePerMTokUsd: outPrice,
    totalUsd: Number(totalUsd.toFixed(8)),
    totalRub: Number((totalUsd * fx.usdRub).toFixed(4)),
    fxUsdRub: fx.usdRub,
    fxUpdated: fx.updated,
    priceUnknown: warnings.includes("price_unknown"),
    warnings,
  };
}

/** Человекочитаемая карточка — её бот показывает перед платным вызовом. */
export function renderCostCard(estimate) {
  if (estimate.priceUnknown) {
    return (
      `⚠️ Цена модели ${estimate.model} неизвестна — каталог OpenRouter сейчас недоступен.\n` +
      "Переключаться вслепую не стоит: повторите позже или выберите модель из последнего списка."
    );
  }
  if (estimate.tier === "free") {
    return (
      `🆓 Бесплатная модель: ${estimate.model}\n` +
      `Оценка запроса: ~${estimate.promptTokens} вход + ~${estimate.expectedOutTokens} выход\n` +
      "Итого: $0.00"
    );
  }
  return (
    `💳 Платная модель: ${estimate.model}\n` +
    `Цена: $${estimate.inPricePerMTokUsd.toFixed(2)}/1M вход, ` +
    `$${estimate.outPricePerMTokUsd.toFixed(2)}/1M выход\n` +
    `Оценка запроса: ~${estimate.promptTokens} вход + ~${estimate.expectedOutTokens} выход\n` +
    `Итого: $${estimate.totalUsd.toFixed(4)} (~₽${estimate.totalRub.toFixed(2)} по курсу ${estimate.fxUsdRub})`
  );
}
