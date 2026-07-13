import {
  ensureVault,
  writeNote,
  ensurePerson,
  searchPersonCandidates,
  appendFeedback,
} from "../vault.mjs";
import { lintVault } from "../lint.mjs";
import { modelPrices } from "../pricing.mjs";
import { listLayers } from "../layers.mjs";

/**
 * Реестр MCP-инструментов secondbrain (ТЗ §9.2). Каждый инструмент —
 * {description, inputSchema (JSON Schema), handler(args, ctx)}.
 * ctx.vaultRoot — корень Obsidian-хранилища (см. vault.mjs).
 */
export const tools = {
  vault_init: {
    description:
      "Создать структуру Obsidian-хранилища (00_Inbox, 10_Diary, 20_People, ... — см. ТЗ §7). Идемпотентно.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const created = await ensureVault(ctx.vaultRoot);
      return { vault_root: ctx.vaultRoot, dirs: created };
    },
  },

  vault_write_note: {
    description:
      "Записать заметку (дневник/фото/документ/решение/inbox) с frontmatter в хранилище (ТЗ §7, §7.1).",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          enum: ["00_Inbox", "10_Diary", "10_Photos", "10_Documents", "30_Decisions"],
        },
        title: { type: "string" },
        body: { type: "string" },
        frontmatter: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["diary", "fact", "decision", "photo", "document"] },
            date: { type: "string" },
            people: { type: "array", items: { type: "string" } },
            source: {
              type: "string",
              enum: [
                "telegram_channel",
                "telegram_dm",
                "telegram_photo",
                "telegram_voice",
                "telegram_video",
                "upload",
              ],
            },
            model: { type: ["string", "null"] },
            status: { type: "string", enum: ["draft", "confirmed"] },
          },
        },
      },
      required: ["folder", "title"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      return writeNote(ctx.vaultRoot, args);
    },
  },

  vault_lint: {
    description:
      "Детерминированный линт хранилища или одной заметки: обязательные поля frontmatter, битые/несинхронные ссылки на персон, дубли персон (ТЗ §7.2). Пишет отчёт в _meta/lint/.",
    inputSchema: {
      type: "object",
      properties: { note_path: { type: "string" } },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      return lintVault(ctx.vaultRoot, { notePath: args?.note_path });
    },
  },

  person_ensure: {
    description:
      "Найти или создать 20_People/Имя_Фамилия_(роль).md для подтверждённого пользователем персонажа (ТЗ §3). Вызывать только после дизамбигуации (L2.5), не до неё.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      return ensurePerson(ctx.vaultRoot, args);
    },
  },

  person_search_candidates: {
    description:
      "Поиск кандидатов-персон по имени/роли для дизамбигуации (ТЗ §3, промт 02_person_disambiguation.md). Заглушка на строковом поиске — в M2 дополняется семантическим поиском через gbrain.search (ТЗ §9.2).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const candidates = await searchPersonCandidates(ctx.vaultRoot, args.query);
      return { candidates };
    },
  },

  feedback_record: {
    description:
      "Записать реакцию 👍/👎 на ответ бота в _wiki/feedback.md хранилища (ТЗ §5, §8, промт 06_feedback_followup.md).",
    inputSchema: {
      type: "object",
      properties: {
        layer: { type: "string" },
        model: { type: "string" },
        reaction: { type: "string", enum: ["👍", "👎"] },
        comment: { type: "string" },
        ref: { type: "string" },
      },
      required: ["reaction"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      return appendFeedback(ctx.vaultRoot, args);
    },
  },

  model_prices: {
    description:
      "Список моделей провайдера, отсортированный по возрастанию цены за токен — для предложения смены модели после 👎 (ТЗ §5).",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", enum: ["openrouter", "yandex"] } },
      required: ["provider"],
      additionalProperties: false,
    },
    async handler(args) {
      return modelPrices(args.provider);
    },
  },

  layers_list: {
    description:
      "Реестр слоёв многослойного анализа (L0–L6 и специализированные), прочитанный из frontmatter Promts/*.md (ТЗ §6.2).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      return { layers: await listLayers() };
    },
  },
};
