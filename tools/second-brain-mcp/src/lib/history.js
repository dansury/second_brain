// Импорт ВСЕЙ истории канала/группы, а не только новых сообщений (ТЗ §4.1).
//
// Telegram Bot API не отдаёт историю чата: бот видит только апдейты, пришедшие
// после того, как его добавили. Поэтому история берётся двумя путями (как это
// сделано в GrowthProducer, src/channels/history_import.py):
//
//   1. публичный веб-превью `https://t.me/s/<username>` с постраничной
//      навигацией `?before=<id>` — публичные каналы (и публичные группы,
//      у которых включён превью);
//   2. JSON-экспорт Telegram Desktop (`result.json`) — приватные каналы,
//      группы и «Избранное», где превью недоступен.
//
// Оба пути детерминированы: парсинг + запись в vault, без LLM. Осмысление
// импортированного (персоны, классификация) — работа слоёв 2-4 агента, ему
// возвращается срез самых свежих записей (`recent`).

import fs from "node:fs/promises";
import path from "node:path";
import { FOLDERS, vaultPath, isoDate } from "./paths.js";
import { writeEntry } from "./entries.js";

/** Стоп-гард пагинации: ~20 постов на страницу → до ~10k постов. */
export const HISTORY_MAX_PAGES = 500;
/** Сколько свежих записей вернуть агенту на осмысление слоями 2-4. */
export const HISTORY_RECENT_LIMIT = 20;
/** Обрезка превью текста в ответе инструмента (сам текст целиком — в vault). */
const RECENT_PREVIEW_CHARS = 400;

const STATE_REL = path.join(".state", "history-import.json");
const BASE_URL = "https://t.me/s/";

// --- разбор страницы t.me/s --------------------------------------------------

// Один блок сообщения: от data-post="<user>/<id>" до следующего data-post.
const POST_RE = /data-post="(?<post>[^"]+)"(?<block>[\s\S]*?)(?=data-post="|$)/g;
const TEXT_DIV_RE = /<div class="tgme_widget_message_text[^"]*"[^>]*>(?<body>[\s\S]*?)<\/div>/;
const TIME_RE = /<time[^>]*datetime="(?<dt>[^"]+)"/;
// Только автор сообщения в группе (`from_author`); имя самого канала
// (`owner_name`) автором записи не является.
const AUTHOR_RE = /class="tgme_widget_message_from_author[^"]*"[^>]*>(?<name>[\s\S]*?)<\/(?:span|a|div)>/;
const BR_RE = /<br\s*\/?>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_LINE_RE = /[ \t]+\n/g;

// Именованные сущности, реально встречающиеся в тексте постов t.me/s;
// числовые (&#8212;, &#x2014;) разбираются отдельно.
const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
  "&laquo;": "«", "&raquo;": "»", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
  "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&middot;": "·", "&deg;": "°",
};

function unescapeHtml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function htmlToText(bodyHtml) {
  return unescapeHtml(String(bodyHtml ?? "").replace(BR_RE, "\n").replace(TAG_RE, ""))
    .replace(WS_LINE_RE, "\n")
    .trim();
}

/** "@name", "https://t.me/name", "t.me/s/name/123" → "name". */
export function normalizeChat(chat) {
  let s = String(chat ?? "").trim();
  if (!s) throw new Error("import_chat_history: не указан канал/группа (chat)");
  s = s.replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "").replace(/^s\//i, "").replace(/^@/, "");
  const first = s.split(/[/?#]/)[0];
  if (/^[+]|^joinchat$/i.test(first)) {
    throw new Error(
      "import_chat_history: приватная ссылка-приглашение — у такого чата нет публичной " +
        "истории. Используйте import_chat_history_file с JSON-экспортом Telegram Desktop."
    );
  }
  if (!/^[A-Za-z0-9_]{4,32}$/.test(first)) {
    throw new Error(`import_chat_history: "${chat}" не похоже на @username канала/группы`);
  }
  return first;
}

/**
 * Детерминированный разбор одной страницы t.me/s → посты (сервисные и пустые
 * сообщения пропускаются). Возвращает в порядке страницы (старые → новые).
 */
export function parseHistoryPage(pageHtml, username) {
  const posts = [];
  const prefix = `${String(username).toLowerCase()}/`;
  POST_RE.lastIndex = 0;
  for (const match of String(pageHtml ?? "").matchAll(POST_RE)) {
    const { post: postRef, block } = match.groups;
    if (!postRef.toLowerCase().startsWith(prefix)) continue;
    const msgId = Number.parseInt(postRef.slice(postRef.lastIndexOf("/") + 1), 10);
    if (!Number.isFinite(msgId)) continue;

    const textMatch = TEXT_DIV_RE.exec(block);
    if (!textMatch) continue; // фото без подписи / сервисное сообщение
    const bodyHtml = textMatch.groups.body.trim();
    const text = htmlToText(bodyHtml);
    if (!text) continue;

    const dt = TIME_RE.exec(block)?.groups.dt ?? null;
    const authorMatch = AUTHOR_RE.exec(block);
    const author = authorMatch ? htmlToText(authorMatch.groups.name) : "";
    posts.push({
      msgId,
      url: `https://t.me/${username}/${msgId}`,
      html: bodyHtml,
      text,
      datetime: dt,
      author,
    });
  }
  return posts;
}

/**
 * Скачивает историю канала/группы со страницы t.me/s с пагинацией `?before=`.
 * Возвращает посты от новых к старым. Fail-soft: сетевая ошибка обрывает
 * пагинацию, но уже собранное отдаётся (частичный импорт лучше пустого).
 */
export async function fetchChatHistory(
  username,
  { limit = 0, sinceId = 0, maxPages = HISTORY_MAX_PAGES, fetchImpl = globalThis.fetch } = {}
) {
  const byId = new Map();
  const warnings = [];
  let before = null;
  let pages = 0;

  for (; pages < maxPages; pages += 1) {
    const url = before === null ? `${BASE_URL}${username}` : `${BASE_URL}${username}?before=${before}`;
    let pageHtml;
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": "second-brain-history-import" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      pageHtml = await response.text();
    } catch (err) {
      warnings.push(`fetch_failed:${err.message}`);
      console.error(`[history] не удалось прочитать ${url}: ${err.message}`);
      break;
    }

    const page = parseHistoryPage(pageHtml, username);
    const fresh = page.filter((p) => !byId.has(p.msgId));
    for (const post of fresh) {
      if (post.msgId > sinceId) byId.set(post.msgId, post);
    }
    if (fresh.length === 0) break;

    const pageMin = Math.min(...page.map((p) => p.msgId));
    if (pageMin <= 1 || pageMin <= sinceId) break;
    if (limit > 0 && byId.size >= limit) break;
    before = pageMin;
  }

  if (pages >= maxPages) warnings.push(`max_pages:${maxPages}`);
  if (byId.size === 0 && warnings.length === 0) warnings.push("empty");

  const newestFirst = [...byId.values()].sort((a, b) => b.msgId - a.msgId);
  return { posts: limit > 0 ? newestFirst.slice(0, limit) : newestFirst, pages, warnings };
}

// --- состояние импорта (идемпотентность между запусками) ---------------------

async function readState() {
  try {
    return JSON.parse(await fs.readFile(vaultPath(STATE_REL), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[history] состояние импорта нечитаемо: ${err.message}`);
    return { version: 1, chats: {} };
  }
}

async function writeState(state) {
  const file = vaultPath(STATE_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Что уже импортировано — по одному чату или по всем. */
export async function historyImportStatus({ chat } = {}) {
  const state = await readState();
  if (!chat) return { chats: state.chats ?? {} };
  const key = String(chat).replace(/^@/, "");
  return { chat: key, ...(state.chats?.[key] ?? { imported: 0, ids: [] }) };
}

// --- запись в vault ----------------------------------------------------------

function stampFromDatetime(datetime, fallbackDate) {
  const parsed = datetime ? new Date(datetime) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    const iso = parsed.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  return { date: fallbackDate || isoDate(), time: "00:00" };
}

function journalFileFor(dateISO) {
  const [y, m] = dateISO.split("-");
  return vaultPath(FOLDERS.journal, y, m, `${dateISO}.md`);
}

async function readJournalOnce(cache, dateISO) {
  if (!cache.has(dateISO)) {
    let content = "";
    try {
      content = await fs.readFile(journalFileFor(dateISO), "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    cache.set(dateISO, content);
  }
  return cache.get(dateISO);
}

/**
 * Пишет один исторический пост в дневник его собственной датой. Дедуп двойной:
 * по id в состоянии импорта и по постоянной ссылке уже в файле дня — состояние
 * можно потерять, vault остаётся источником правды.
 */
async function writeHistoryPost(post, { chat, via, dryRun, cache }) {
  const { date, time } = stampFromDatetime(post.datetime, post.date);
  const anchor = post.url || `${chat}#${post.msgId}`;
  const existing = await readJournalOnce(cache, date);
  if (existing.includes(anchor)) return { skipped: "already_in_vault", date };
  if (dryRun) return { date, dry: true };

  const bodyLines = [];
  if (post.author) bodyLines.push(`**Автор:** ${post.author}`, "");
  bodyLines.push(post.text);
  if (post.url) bodyLines.push("", `[Оригинал в Telegram](${post.url})`);
  else bodyLines.push("", `_Источник: ${chat}, сообщение ${post.msgId}_`);

  const result = await writeEntry({
    type: "journal",
    date,
    time,
    heading: post.url ? `@${chat}/${post.msgId}` : `${chat} · сообщение ${post.msgId}`,
    frontmatter: { source: "telegram-history", via, tg_chat: chat },
    body: bodyLines.join("\n"),
  });
  cache.set(date, `${existing}${anchor}`); // дедуп внутри одного прогона
  return { date, path: result.path };
}

function recentSlice(posts) {
  return posts.slice(0, HISTORY_RECENT_LIMIT).map((p) => ({
    msg_id: p.msgId,
    url: p.url ?? null,
    date: stampFromDatetime(p.datetime, p.date).date,
    author: p.author || null,
    preview: p.text.slice(0, RECENT_PREVIEW_CHARS),
  }));
}

/** Общий хвост обоих импортов: запись в vault + обновление состояния. */
async function ingest(posts, { chat, via, dryRun, warnings }) {
  const state = await readState();
  state.chats ??= {};
  const prev = state.chats[chat] ?? { imported: 0, ids: [] };
  const seen = new Set(prev.ids ?? []);

  const cache = new Map();
  const dates = new Set();
  let imported = 0;
  let skipped = 0;

  // Старые → новые: дневник читается сверху вниз, порядок секций естественный.
  for (const post of [...posts].sort((a, b) => a.msgId - b.msgId)) {
    if (seen.has(post.msgId)) {
      skipped += 1;
      continue;
    }
    let result;
    try {
      result = await writeHistoryPost(post, { chat, via, dryRun, cache });
    } catch (err) {
      warnings.push(`write_failed:${post.msgId}`);
      console.error(`[history] ${chat}/${post.msgId} не записан: ${err.message}`);
      continue;
    }
    if (result.skipped) {
      skipped += 1;
      seen.add(post.msgId);
      continue;
    }
    imported += 1;
    dates.add(result.date);
    if (!dryRun) seen.add(post.msgId);
  }

  // Состояние обновляем и когда всё оказалось дублями, найденными по ссылке в
  // файле дня: так восстановленное состояние переживает потерю .state.
  const ids = [...seen].sort((a, b) => a - b);
  if (!dryRun && ids.length !== (prev.ids?.length ?? 0)) {
    state.chats[chat] = {
      via,
      last_run_at: new Date().toISOString(),
      imported: ids.length,
      min_msg_id: ids[0] ?? null,
      max_msg_id: ids[ids.length - 1] ?? null,
      ids,
    };
    await writeState(state);
  }

  const newestFirst = [...posts].sort((a, b) => b.msgId - a.msgId);
  return {
    chat,
    via,
    dry_run: dryRun,
    fetched: posts.length,
    imported,
    skipped,
    days: [...dates].sort(),
    max_msg_id: ids[ids.length - 1] ?? null,
    recent: recentSlice(newestFirst),
    warnings,
  };
}

/**
 * Импорт истории публичного канала/группы через t.me/s (ТЗ §4.1).
 * `limit: 0` — вся доступная история; `sinceId` — только сообщения новее.
 */
export async function importChatHistory({
  chat,
  limit = 0,
  sinceId = 0,
  dryRun = false,
  maxPages = HISTORY_MAX_PAGES,
  fetchImpl,
} = {}) {
  const username = normalizeChat(chat);
  const { posts, warnings } = await fetchChatHistory(username, { limit, sinceId, maxPages, fetchImpl });
  if (posts.length === 0) {
    return {
      chat: username,
      via: "tme-preview",
      dry_run: dryRun,
      fetched: 0,
      imported: 0,
      skipped: 0,
      days: [],
      recent: [],
      warnings: warnings.length ? warnings : ["empty"],
      hint:
        "Публичного превью t.me/s у этого чата нет (приватный канал/группа) или он пуст. " +
        "Выгрузите историю в Telegram Desktop (Экспорт → JSON) и вызовите import_chat_history_file.",
    };
  }
  return ingest(posts, { chat: username, via: "tme-preview", dryRun, warnings });
}

// --- JSON-экспорт Telegram Desktop ------------------------------------------

/** text: string | [ "строка", {type, text}, … ] → плоский текст. */
export function flattenExportText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
}

/** Экспорт Telegram Desktop (result.json) → посты в формате импорта. */
export function parseExportJson(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const title = data?.name ? String(data.name) : "";
  const posts = [];
  for (const message of messages) {
    if (message?.type && message.type !== "message") continue; // service/join/pin
    const text = flattenExportText(message?.text).trim();
    if (!text) continue;
    const msgId = Number.parseInt(message?.id, 10);
    if (!Number.isFinite(msgId)) continue;
    posts.push({
      msgId,
      url: null,
      html: "",
      text,
      datetime: message?.date ?? null,
      author: message?.from ? String(message.from) : "",
    });
  }
  return { title, posts };
}

/**
 * Импорт истории из JSON-экспорта Telegram Desktop — путь для приватных
 * каналов, групп и «Избранного», у которых нет публичного превью.
 */
export async function importChatHistoryFile({
  file,
  chat,
  limit = 0,
  sinceId = 0,
  dryRun = false,
} = {}) {
  if (!file) throw new Error("import_chat_history_file: не указан путь к экспорту (file)");
  let target = path.resolve(String(file));
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error(`import_chat_history_file: файл не найден — ${target}`);
  if (stat.isDirectory()) target = path.join(target, "result.json");

  const raw = await fs.readFile(target, "utf8");
  let parsed;
  try {
    parsed = parseExportJson(raw);
  } catch (err) {
    throw new Error(`import_chat_history_file: ${target} — не JSON-экспорт Telegram Desktop (${err.message})`);
  }

  const key = chat ? String(chat).replace(/^@/, "") : parsed.title || path.basename(path.dirname(target));
  const posts = parsed.posts.filter((p) => p.msgId > sinceId);
  const selected = limit > 0 ? posts.sort((a, b) => b.msgId - a.msgId).slice(0, limit) : posts;
  const warnings = selected.length === 0 ? ["empty"] : [];
  return ingest(selected, { chat: key, via: "tg-export", dryRun, warnings });
}
