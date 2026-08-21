import fs from "node:fs/promises";
import path from "node:path";
import { vaultRoot, vaultPath, FOLDERS, slugify, isoDate, isoTime, toWikiLink } from "./paths.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

function assertType(type) {
  if (!FOLDERS[type]) {
    throw new Error(`obsidian_write_entry: неизвестный type "${type}", ожидается один из: ${Object.keys(FOLDERS).join(", ")}`);
  }
}

function journalPath(dateISO) {
  const [y, m] = dateISO.split("-");
  return vaultPath(FOLDERS.journal, y, m, `${dateISO}.md`);
}

function entryPath(type, dateISO, slugHint) {
  const slug = slugify(slugHint || "entry");
  return vaultPath(FOLDERS[type], `${dateISO}-${slug}.md`);
}

function normalizeLinks(links = []) {
  return links.map(toWikiLink);
}

/**
 * Записывает структурированный результат слоёв 2-7 в vault по правилам
 * ТЗ §6/§11 (frontmatter + lint + идемпотентность). Единственная точка
 * записи в vault — см. Promts/08_obsidian_lint.md «Запреты».
 *
 * `time`/`heading` задают заголовок секции журнала: по умолчанию это
 * «HH:MM — запись» текущим временем, а импорт истории (слой 10,
 * lib/history.js) пишет постом его собственные время и ссылку.
 */
export async function writeEntry({ type, frontmatter = {}, body = "", links = [], date, time, heading }) {
  assertType(type);
  const dateISO = date || isoDate();
  const people = normalizeLinks(links.length ? links : frontmatter.people || []);
  const baseFrontmatter = { type, date: dateISO, ...frontmatter, people };

  if (type === "journal") {
    const filePath = journalPath(dateISO);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let existing = null;
    try {
      existing = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    const section = `\n## ${time || isoTime()} — ${heading || "запись"}\n${body.trim()}\n`;

    if (existing) {
      const { frontmatter: existingFm, body: existingBody } = parseFrontmatter(existing);
      const mergedPeople = Array.from(new Set([...(existingFm.people || []), ...people]));
      const mergedTags = Array.from(new Set([...(existingFm.tags || []), ...(frontmatter.tags || [])]));
      const nextFm = { ...existingFm, ...baseFrontmatter, people: mergedPeople, tags: mergedTags };
      const nextContent = stringifyFrontmatter(nextFm, existingBody + section);
      await fs.writeFile(filePath, nextContent, "utf8");
      return { path: filePath, created: false };
    }

    await fs.writeFile(filePath, stringifyFrontmatter(baseFrontmatter, section), "utf8");
    return { path: filePath, created: true };
  }

  // Не-журнальные типы: один файл на запись, идемпотентно по slug.
  const slugHint = frontmatter.title || frontmatter.slug || body.slice(0, 40);
  const filePath = entryPath(type, dateISO, slugHint);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existedBefore = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  await fs.writeFile(filePath, stringifyFrontmatter(baseFrontmatter, `\n${body.trim()}\n`), "utf8");
  return { path: filePath, created: !existedBefore };
}

async function walkMarkdown(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return acc;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Текстовый/метаданный поиск по vault-у — дополняет семантический поиск
 * gbrain (ТЗ §10.1). Используется слоем 4c для поиска прецедентов.
 */
export async function searchVault({ query, type, status, limit = 20 }) {
  const root = vaultRoot();
  const files = await walkMarkdown(root);
  const q = String(query ?? "").trim().toLowerCase();
  const results = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    if (type && frontmatter.type !== type) continue;
    if (status && (frontmatter.status || "open") !== status) continue;

    const haystack = `${JSON.stringify(frontmatter)}\n${body}`.toLowerCase();
    if (q && !haystack.includes(q)) continue;

    results.push({
      path: path.relative(root, filePath),
      type: frontmatter.type,
      date: frontmatter.date,
      status: frontmatter.status,
      snippet: body.trim().slice(0, 200),
    });
  }

  results.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return results.slice(0, limit);
}
