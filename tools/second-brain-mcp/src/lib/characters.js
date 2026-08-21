import fs from "node:fs/promises";
import path from "node:path";
import { vaultPath, personSlug, personFilePath, isoDate } from "./paths.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { stringSimilarity, clamp01 } from "./similarity.js";

const peopleDir = () => vaultPath("People");

async function listPersonFiles() {
  try {
    const files = await fs.readdir(peopleDir());
    return files.filter((f) => f.endsWith(".md"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function readPerson(fileName) {
  const filePath = path.join(peopleDir(), fileName);
  const raw = await fs.readFile(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  return { fileName, filePath, frontmatter, body };
}

/**
 * Нечёткий поиск персоны по имени/роли/алиасам.
 * Возвращает кандидатов, отсортированных по убыванию score (0..1) —
 * см. правило дизамбигуации в Promts/02_entity_recognition.md.
 */
export async function lookupCharacter({ name, role }) {
  const files = await listPersonFiles();
  const candidates = [];

  for (const fileName of files) {
    const person = await readPerson(fileName);
    const fm = person.frontmatter;
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
    const nameCandidates = [fm.name, ...aliases].filter(Boolean);
    const nameScore = nameCandidates.length
      ? Math.max(...nameCandidates.map((n) => stringSimilarity(name, n)))
      : 0;

    let roleBonus = 0;
    if (role && fm.role) {
      roleBonus = role.trim().toLowerCase() === String(fm.role).trim().toLowerCase() ? 0.15 : -0.1;
    }

    const score = clamp01(nameScore + roleBonus);
    if (score > 0.3) {
      candidates.push({
        link: `[[${fileName.replace(/\.md$/, "")}]]`,
        name: fm.name,
        role: fm.role,
        aliases,
        score: Math.round(score * 100) / 100,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

/**
 * Создать или обновить файл персоны. Идемпотентно по (name, role) —
 * повторный вызов с теми же name/role обновляет тот же файл, не плодит
 * дубликаты (ТЗ §11).
 */
export async function upsertCharacter({ name, role, aliases = [] }) {
  if (!name || !role) throw new Error("upsert_character: name и role обязательны");

  const filePath = personFilePath(name, role);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existing = null;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const today = isoDate();

  if (existing) {
    const { frontmatter, body } = parseFrontmatter(existing);
    const existingAliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [];
    const mergedAliases = Array.from(new Set([...existingAliases, ...aliases])).filter(Boolean);
    const nextFrontmatter = {
      name,
      role,
      aliases: mergedAliases,
      first_mentioned: frontmatter.first_mentioned || today,
      updated: today,
    };
    await fs.writeFile(filePath, stringifyFrontmatter(nextFrontmatter, body), "utf8");
    return { path: filePath, created: false, link: `[[${personSlug(name, role)}]]` };
  }

  const frontmatter = {
    name,
    role,
    aliases,
    first_mentioned: today,
    updated: today,
  };
  const body = `\n## Заметки\n\n(Обратные ссылки на упоминания — во вкладке Obsidian «Backlinks», не дублируются здесь.)\n`;
  await fs.writeFile(filePath, stringifyFrontmatter(frontmatter, body), "utf8");
  return { path: filePath, created: true, link: `[[${personSlug(name, role)}]]` };
}
