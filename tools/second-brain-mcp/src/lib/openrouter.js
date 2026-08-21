/**
 * Единая точка обращения к каталогу моделей OpenRouter.
 *
 * Порт `src/llm/openrouter.py` + `src/llm/prices.py` из GrowthProducer,
 * адаптированный под second_brain: там прайс-таблица лежит committed-семенем
 * (`config/model_prices.json`) и обновляется кроном, здесь каталог тянется
 * живьём — у бота и так есть OPENROUTER_API_KEY — и кэшируется в процессе.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 ч

/** @type {{ at: number, models: OpenRouterModel[] } | null} */
let _cache = null;

/**
 * @typedef {Object} OpenRouterModel
 * @property {string} id
 * @property {string} name
 * @property {"openrouter"} provider
 * @property {number|null} promptPricePerMTok   цена за 1M входных токенов, USD
 * @property {number|null} completionPricePerMTok
 * @property {number|null} contextTokens
 * @property {boolean} isFree                   обе цены = 0
 * @property {string[]} modalities              input_modalities: text/image/file
 */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const prompt = toNumber(raw.pricing?.prompt);
  const completion = toNumber(raw.pricing?.completion);
  const modalities = Array.isArray(raw.architecture?.input_modalities)
    ? raw.architecture.input_modalities.map(String)
    : ["text"];
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    provider: "openrouter",
    promptPricePerMTok: prompt === null ? null : prompt * 1_000_000,
    completionPricePerMTok: completion === null ? null : completion * 1_000_000,
    contextTokens: toNumber(raw.context_length),
    isFree: prompt === 0 && (completion === 0 || completion === null),
    modalities,
  };
}

/** Сбрасывает процессный кэш каталога (тест-хук). */
export function resetCatalogCache() {
  _cache = null;
}

/**
 * Каталог моделей OpenRouter. Fail-soft: при сетевой ошибке отдаёт последний
 * успешный ответ из процессного кэша (даже протухший) и поле `error`.
 *
 * @returns {Promise<{models: OpenRouterModel[], error?: string, stale?: boolean}>}
 */
export async function fetchCatalog({ fetchImpl = fetch, ttlMs = DEFAULT_TTL_MS, refresh = false } = {}) {
  if (!refresh && _cache && Date.now() - _cache.at < ttlMs) {
    return { models: _cache.models };
  }

  const headers = { "Content-Type": "application/json" };
  if (process.env.OPENROUTER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  }

  let payload;
  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, { headers });
    if (!response.ok) throw new Error(`OpenRouter вернул ${response.status}`);
    payload = await response.json();
  } catch (err) {
    const message = `Не удалось обратиться к OpenRouter: ${err.message}`;
    if (_cache) return { models: _cache.models, error: message, stale: true };
    return { models: [], error: message };
  }

  const models = (payload?.data || []).map(normalize).filter(Boolean);
  if (models.length) _cache = { at: Date.now(), models };
  return { models };
}

/** Свободные (нулевая цена) модели OpenRouter — сырой срез каталога. */
export async function freeCatalogSlice(options = {}) {
  const { models, error, stale } = await fetchCatalog(options);
  return { models: models.filter((m) => m.isFree), error, stale };
}
