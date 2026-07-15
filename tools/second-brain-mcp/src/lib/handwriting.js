import fs from "node:fs/promises";
import path from "node:path";
import { handwritingFilePath, isoDate } from "./paths.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

function bodyToNotes(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function notesToBody(notes) {
  return `\n${notes.map((n) => `- ${n}`).join("\n")}\n`;
}

/**
 * Заготовка API слоя 7 (ТЗ §8.3, M5 в дорожной карте) — описательные заметки
 * об особенностях начертания, НЕ биометрический шаблон.
 */
export async function rememberHandwriting({ person, notes }) {
  if (!person || !notes?.length) throw new Error("remember_handwriting: person и notes обязательны");
  const filePath = handwritingFilePath(person);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existingNotes = [];
  let existed = false;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    existed = true;
    existingNotes = bodyToNotes(parseFrontmatter(raw).body);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const merged = Array.from(new Set([...existingNotes, ...notes]));
  const frontmatter = { person, updated: isoDate() };
  await fs.writeFile(filePath, stringifyFrontmatter(frontmatter, notesToBody(merged)), "utf8");
  return { path: filePath, created: !existed, notes: merged };
}

export async function getHandwritingProfile({ person }) {
  const filePath = handwritingFilePath(person);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const { body } = parseFrontmatter(raw);
    return { found: true, path: filePath, notes: bodyToNotes(body) };
  } catch (err) {
    if (err.code === "ENOENT") return { found: false, notes: [] };
    throw err;
  }
}
