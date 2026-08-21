#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { lookupCharacter, upsertCharacter } from "./lib/characters.js";
import { writeEntry, searchVault } from "./lib/entries.js";
import { setDecisionOutcome, DECISION_STATUSES } from "./lib/decisions.js";
import { recordFeedback } from "./lib/feedback.js";
import { listModelsByPrice, listFreeModels, recommendModelForLayer } from "./lib/models.js";
import { estimateCost, renderCostCard } from "./lib/cost.js";
import { rememberHandwriting, getHandwritingProfile } from "./lib/handwriting.js";
import { FOLDERS } from "./lib/paths.js";

const server = new McpServer({ name: "second-brain", version: "0.1.0" });

function asJsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

server.tool(
  "lookup_character",
  "Нечёткий поиск персоны в People/ по имени и (опционально) роли. " +
    "Возвращает кандидатов с score 0..1 — см. Promts/02_entity_recognition.md для правила дизамбигуации.",
  { name: z.string().describe("Имя, как упомянуто в тексте"), role: z.string().optional().describe("Роль/контекст, если известна") },
  async ({ name, role }) => asJsonResult(await lookupCharacter({ name, role }))
);

server.tool(
  "upsert_character",
  "Создать или обновить People/Имя_Фамилия_(роль).md. Идемпотентно по (name, role).",
  {
    name: z.string(),
    role: z.string(),
    aliases: z.array(z.string()).optional().default([]),
  },
  async ({ name, role, aliases }) => asJsonResult(await upsertCharacter({ name, role, aliases }))
);

server.tool(
  "obsidian_write_entry",
  `Записать структурированную запись в vault (lint + frontmatter). type ∈ [${Object.keys(FOLDERS).join(", ")}]. ` +
    "Единственная точка записи в vault, см. Promts/08_obsidian_lint.md.",
  {
    type: z.enum(["journal", "decision", "document", "photo-people", "handwriting"]),
    frontmatter: z.record(z.any()).optional().default({}),
    body: z.string(),
    links: z.array(z.string()).optional().default([]),
    date: z.string().optional().describe("YYYY-MM-DD, по умолчанию — сегодня"),
  },
  async (args) => asJsonResult(await writeEntry(args))
);

server.tool(
  "search_vault",
  "Текстовый/метаданный поиск по vault (дополняет семантический поиск gbrain). Используется слоем 4c для прецедентов " +
    "(status: outcome-good/outcome-bad — решённые прецеденты) и слоем 4f для поиска решения, чей исход сообщил пользователь (status: open).",
  {
    query: z.string(),
    type: z.enum(["journal", "decision", "document", "photo-people", "handwriting"]).optional(),
    status: z.enum(DECISION_STATUSES).optional().describe("Фильтр по frontmatter status (для type: decision)"),
    limit: z.number().int().positive().max(100).optional().default(20),
  },
  async (args) => asJsonResult(await searchVault(args))
);

server.tool(
  "set_decision_outcome",
  "Проставить исход прошлого решения в Decisions/: frontmatter status (open|outcome-good|outcome-bad) + секция «Исход». " +
    "Слой 4f — именно эти статусы делают запись прецедентом для слоя 4c. См. Promts/04f_decision_outcome.md.",
  {
    ref: z.string().describe("path из результата search_vault (Decisions/….md) или [[wikilink]] записи решения"),
    status: z.enum(DECISION_STATUSES),
    note: z.string().optional().describe("Чем закончилось — словами пользователя"),
  },
  async (args) => asJsonResult(await setDecisionOutcome(args))
);

server.tool(
  "record_feedback",
  "Записать 👍/👎 в Wiki/Feedback.md вместе с моделью/слоем/причиной. См. Promts/09_feedback_and_model_switch.md.",
  {
    rating: z.enum(["up", "down"]),
    reason: z.string().optional(),
    model: z.string(),
    layer: z.string().optional(),
    context: z.string().optional(),
  },
  async (args) => asJsonResult(await recordFeedback(args))
);

server.tool(
  "list_models_by_price",
  "Список моделей провайдера по возрастанию цены за промпт-токен — для 👎-флоу слоя 9. " +
    "Бесплатные (isFree) идут первыми; freeOnly=true оставляет только их.",
  {
    provider: z.enum(["openrouter", "yandex"]).optional().default("openrouter"),
    limit: z.number().int().positive().max(100).optional().default(15),
    freeOnly: z.boolean().optional().default(false),
  },
  async (args) => asJsonResult(await listModelsByPrice(args))
);

server.tool(
  "list_free_models",
  "Топ БЕСПЛАТНЫХ моделей OpenRouter (цена $0), отранжированных рейтингом shir-man и суточной квотой. " +
    "Основной ответ на «переключи на бесплатную» в слое 9. modalities=[\"image\"] — только модели с картинками (слои 06/07).",
  {
    limit: z.number().int().positive().max(50).optional().default(10),
    modalities: z.array(z.enum(["text", "image", "file"])).optional().default([]),
  },
  async (args) => asJsonResult(await listFreeModels(args))
);

server.tool(
  "recommend_model_for_layer",
  "Какую модель брать на слой конвейера: некритичные слои (роутер, чистка расшифровки, NER, lint) → " +
    "топ-1 бесплатная OpenRouter, критичные (риски, прецеденты, прогноз, синтез, почерк) → платный дефолт. " +
    "Политика — config/layer_policy.json.",
  { layer: z.string().describe('Имя слоя, напр. "04c_precedents" или короткое "04c"') },
  async (args) => asJsonResult(await recommendModelForLayer(args))
);

server.tool(
  "estimate_model_cost",
  "Оценка стоимости одного вызова модели в USD и рублях (курс — config/fx.json) + готовая карточка цены. " +
    "Показывать перед переключением на платную модель.",
  {
    model: z.string(),
    layer: z.string().optional().describe("Слой — из него берётся ожидаемый размер ответа"),
    promptTokens: z.number().int().nonnegative().optional(),
    promptText: z.string().optional().describe("Альтернатива promptTokens: посчитаем ~4 символа/токен"),
  },
  async (args) => {
    const estimate = await estimateCost({ ...args, promptTokens: args.promptTokens ?? null, promptText: args.promptText ?? null });
    return asJsonResult({ ...estimate, card: renderCostCard(estimate) });
  }
);

server.tool(
  "remember_handwriting",
  "Добавить описательные заметки об особенностях почерка персоны (не биометрия). Слой 7.",
  { person: z.string(), notes: z.array(z.string()).min(1) },
  async (args) => asJsonResult(await rememberHandwriting(args))
);

server.tool(
  "get_handwriting_profile",
  "Получить накопленные заметки о почерке персоны для подсказки при расшифровке. Слой 7.",
  { person: z.string() },
  async (args) => asJsonResult(await getHandwritingProfile(args))
);

const transport = new StdioServerTransport();
await server.connect(transport);
