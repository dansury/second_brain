/**
 * Каталог топовых БЕСПЛАТНЫХ моделей.
 *
 * Порт `src/llm/free_catalog.py` из GrowthProducer (shir-man top-models,
 * дисковый кэш на 24 ч, атомарная запись, fail-soft на протухший кэш),
 * адаптированный под second_brain: у нас LLM ходит через OpenRouter, поэтому
 * авторитетный список id — сам каталог OpenRouter (нулевая цена), а shir-man
 * даёт ранжирование и суточные квоты. Модель попадает в выдачу, только если
 * она реально доступна там, куда мы будем слать запрос.
 */

import fs from "node:fs/promises";
import nodePath from "node:path";
import { freeCatalogSlice } from "./openrouter.js";
import { dataPath } from "./runtimePaths.js";

export const SHIR_MAN_URL = "https://shir-man.com/api/free-llm/top-models";

const DEFAULT_MAX_AGE_H = 24;

export class FreeCatalogUnavailable extends Error {}

function cachePath() {
  return process.env.FREE_MODELS_CACHE || dataPath("free_models.json");
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Базовый id без суффикса варианта: "deepseek/r1:free" -> "deepseek/r1". */
function baseId(id) {
  return String(id ?? "").split(":")[0].toLowerCase();
}

/** Толерантный разбор ответа shir-man: схема менялась, ключи бывают разные. */
function parseShirMan(payload) {
  let rows = [];
  if (Array.isArray(payload)) rows = payload;
  else if (payload && typeof payload === "object") {
    for (const key of ["models", "data", "top_models", "result"]) {
      if (Array.isArray(payload[key])) {
        rows = payload[key];
        break;
      }
    }
  }
  return rows
    .filter((r) => r && typeof r === "object")
    .map((r, index) => {
      const id = r.id || r.model || r.model_id || r.slug;
      if (!id) return null;
      return {
        id: String(id),
        label: String(r.label || r.name || r.title || id),
        provider: String(r.provider || r.vendor || "openrouter"),
        contextTokens: toInt(r.context_tokens ?? r.context ?? r.context_length),
        dailyQuota: toInt(r.daily_quota ?? r.quota ?? r.requests_per_day),
        notes: r.notes || r.description ? String(r.notes || r.description) : null,
        rank: index,
      };
    })
    .filter(Boolean);
}

async function fetchShirMan(fetchImpl) {
  try {
    const response = await fetchImpl(SHIR_MAN_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`shir-man вернул ${response.status}`);
    return parseShirMan(await response.json());
  } catch {
    return []; // рейтинг — обогащение, а не источник истины
  }
}

/**
 * Сливает каталог OpenRouter (кто реально доступен) с рейтингом shir-man
 * (кто из них лучше и с какой квотой) и сортирует «топ бесплатных».
 */
function merge(openrouterFree, ranked) {
  const rankByBase = new Map();
  for (const r of ranked) {
    const key = baseId(r.id);
    if (!rankByBase.has(key)) rankByBase.set(key, r);
  }

  const models = openrouterFree.map((m) => {
    const hint = rankByBase.get(baseId(m.id));
    return {
      id: m.id,
      label: hint?.label || m.name,
      provider: "openrouter",
      contextTokens: m.contextTokens ?? hint?.contextTokens ?? null,
      dailyQuota: hint?.dailyQuota ?? null,
      modalities: m.modalities,
      rank: hint ? hint.rank : null,
      notes: hint?.notes ?? null,
    };
  });

  models.sort((a, b) => {
    if (a.rank !== b.rank) {
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    }
    if ((b.dailyQuota ?? 0) !== (a.dailyQuota ?? 0)) return (b.dailyQuota ?? 0) - (a.dailyQuota ?? 0);
    return (b.contextTokens ?? 0) - (a.contextTokens ?? 0);
  });
  return models;
}

async function readCache(path) {
  try {
    const doc = JSON.parse(await fs.readFile(path, "utf8"));
    if (!doc || !Array.isArray(doc.models)) return { models: [], fetchedAt: null };
    const fetchedAt = typeof doc.fetched_at === "string" ? Date.parse(doc.fetched_at) : NaN;
    return { models: doc.models, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null };
  } catch {
    return { models: [], fetchedAt: null };
  }
}

/** Атомарная запись: .tmp + rename, чтобы параллельный читатель не поймал обрывок. */
async function writeCache(path, models) {
  const body = JSON.stringify({ fetched_at: new Date().toISOString(), models }, null, 2);
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, path);
}

/**
 * Тянет свежий список бесплатных моделей и кладёт его в кэш.
 * При недоступности OpenRouter — отдаёт последний кэш; если и его нет,
 * бросает FreeCatalogUnavailable.
 */
export async function refreshFreeModels({ fetchImpl = fetch, path = cachePath() } = {}) {
  const [{ models: orFree, error }, ranked] = await Promise.all([
    freeCatalogSlice({ fetchImpl, refresh: true }),
    fetchShirMan(fetchImpl),
  ]);

  if (!orFree.length) {
    const { models: cached } = await readCache(path);
    if (cached.length) return cached;
    throw new FreeCatalogUnavailable(
      error || "OpenRouter не вернул бесплатных моделей и кэша нет",
    );
  }

  const models = merge(orFree, ranked);
  try {
    await writeCache(path, models);
  } catch {
    /* кэш — оптимизация, а не обязательство */
  }
  return models;
}

/**
 * Список бесплатных моделей: свежий кэш (моложе maxAgeH) отдаётся как есть,
 * иначе — обновление. См. Promts/09_feedback_and_model_switch.md.
 */
export async function loadFreeModels({
  fetchImpl = fetch,
  maxAgeH = DEFAULT_MAX_AGE_H,
  allowRefresh = true,
  path = cachePath(),
} = {}) {
  const { models, fetchedAt } = await readCache(path);
  if (models.length && fetchedAt && Date.now() - fetchedAt < maxAgeH * 3600_000) {
    return models;
  }
  if (!allowRefresh) {
    if (models.length) return models;
    throw new FreeCatalogUnavailable(`нет кэша ${path}, обновление запрещено`);
  }
  return refreshFreeModels({ fetchImpl, path });
}

/** Фильтр по требуемым модальностям (vision-слои не берут text-only модель). */
export function filterByModalities(models, required = []) {
  if (!required.length) return models;
  return models.filter((m) => required.every((need) => (m.modalities || ["text"]).includes(need)));
}

/**
 * Топ-1 бесплатная модель — дефолт для некритичных слоёв и для cheap-тира
 * smart_model_routing. null, если каталог недоступен (вызывающий решает сам).
 */
export async function freeTop1(options = {}) {
  try {
    const models = filterByModalities(await loadFreeModels(options), options.modalities || []);
    return models.length ? models[0].id : null;
  } catch {
    return null;
  }
}
