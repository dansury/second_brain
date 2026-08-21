#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { lookupCharacter, upsertCharacter } from "./lib/characters.js";
import { writeEntry, searchVault } from "./lib/entries.js";
import { setDecisionOutcome, DECISION_STATUSES } from "./lib/decisions.js";
import { recordFeedback } from "./lib/feedback.js";
import { listModelsByPrice } from "./lib/models.js";
import { rememberHandwriting, getHandwritingProfile } from "./lib/handwriting.js";
import { importChatHistory, importChatHistoryFile, historyImportStatus } from "./lib/history.js";
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
  "Список моделей провайдера по возрастанию цены за промпт-токен — для 👎-флоу слоя 9.",
  { provider: z.enum(["openrouter", "yandex"]).optional().default("openrouter") },
  async ({ provider }) => asJsonResult(await listModelsByPrice({ provider }))
);

server.tool(
  "import_chat_history",
  "Импортировать ВСЮ прошлую историю канала/группы в vault (слой 10), а не только новые сообщения: " +
    "Telegram Bot API историю не отдаёт, поэтому посты берутся с публичного превью t.me/s/<username> " +
    "с пагинацией. Идемпотентно: повторный вызов не дублирует уже импортированное. " +
    "Приватный канал/группа без превью → import_chat_history_file. См. Promts/10_history_import.md.",
  {
    chat: z.string().describe("@username, t.me/username или голый username канала/группы"),
    limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Максимум постов (0 — вся доступная история, по умолчанию)"),
    since_id: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Импортировать только сообщения новее этого id (докачка; max_msg_id из прошлого ответа)"),
    dry_run: z.boolean().optional().default(false).describe("Только посчитать, не писать в vault"),
  },
  async ({ chat, limit, since_id, dry_run }) =>
    asJsonResult(await importChatHistory({ chat, limit, sinceId: since_id, dryRun: dry_run }))
);

server.tool(
  "import_chat_history_file",
  "Импортировать историю из JSON-экспорта Telegram Desktop (Настройки → Экспорт данных → формат JSON). " +
    "Путь для приватных каналов, групп и «Избранного», у которых нет публичного превью t.me/s. " +
    "Идемпотентен так же, как import_chat_history.",
  {
    file: z.string().describe("Путь к result.json (или к папке экспорта) внутри контейнера"),
    chat: z.string().optional().describe("Метка чата в состоянии импорта; по умолчанию — name из экспорта"),
    limit: z.number().int().nonnegative().optional().default(0),
    since_id: z.number().int().nonnegative().optional().default(0),
    dry_run: z.boolean().optional().default(false),
  },
  async ({ file, chat, limit, since_id, dry_run }) =>
    asJsonResult(await importChatHistoryFile({ file, chat, limit, sinceId: since_id, dryRun: dry_run }))
);

server.tool(
  "history_import_status",
  "Что уже импортировано из истории чатов: сколько сообщений, диапазон id, когда был последний прогон. " +
    "Слой 10 — перед повторным импортом и для докачки (since_id = max_msg_id).",
  { chat: z.string().optional().describe("@username/метка чата; без него — все чаты") },
  async ({ chat }) => asJsonResult(await historyImportStatus({ chat }))
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
