import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.mjs";
import { personFileName, dateTitleFileName } from "./slug.mjs";

// Структура хранилища — ровно как описано в ТЗ.md §7.
export const VAULT_DIRS = [
  "00_Inbox",
  "10_Diary",
  "10_Photos",
  "10_Documents",
  "20_People",
  "30_Decisions",
  "_attachments",
  "_meta/lint",
  "_wiki",
];

export const NOTE_FOLDERS = new Set([
  "00_Inbox",
  "10_Diary",
  "10_Photos",
  "10_Documents",
  "30_Decisions",
]);

export function vaultRootFromEnv() {
  return process.env.OBSIDIAN_VAULT_PATH || "/opt/data/vault";
}

export async function ensureVault(vaultRoot) {
  const created = [];
  for (const dir of VAULT_DIRS) {
    const full = path.join(vaultRoot, dir);
    await fs.mkdir(full, { recursive: true });
    created.push(dir);
  }
  return created;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Записать заметку (дневник/фото/документ/решение/inbox) с frontmatter.
 */
export async function writeNote(vaultRoot, { folder, title, body, frontmatter }) {
  if (!NOTE_FOLDERS.has(folder)) {
    throw new Error(
      `Недопустимая папка "${folder}". Разрешено: ${[...NOTE_FOLDERS].join(", ")}`
    );
  }
  const fm = {
    type: frontmatter?.type || "fact",
    date: frontmatter?.date || new Date().toISOString().slice(0, 10),
    people: frontmatter?.people || [],
    source: frontmatter?.source || "telegram_dm",
    model: frontmatter?.model || null,
    status: frontmatter?.status || "draft",
  };
  const fileName = dateTitleFileName(fm.date, title);
  const relPath = path.join(folder, fileName);
  const fullPath = path.join(vaultRoot, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const content = stringifyFrontmatter(fm, body || "");
  await fs.writeFile(fullPath, content, "utf8");
  return { path: relPath.split(path.sep).join("/"), frontmatter: fm };
}

export async function readNote(vaultRoot, relPath) {
  const fullPath = path.join(vaultRoot, relPath);
  const content = await fs.readFile(fullPath, "utf8");
  return parseFrontmatter(content);
}

/** Найти или создать 20_People/Имя_Фамилия_(роль).md (ТЗ §3). */
export async function ensurePerson(vaultRoot, { name, role, aliases }) {
  const fileName = personFileName(name, role);
  const relPath = path.join("20_People", fileName);
  const fullPath = path.join(vaultRoot, relPath);
  if (await pathExists(fullPath)) {
    return { path: relPath.split(path.sep).join("/"), created: false };
  }
  const fm = {
    type: "person",
    role: role || "не уточнено",
    aliases: aliases && aliases.length ? aliases : [name],
    first_seen: new Date().toISOString().slice(0, 10),
    handwriting_notes: [],
  };
  const body = `# ${name}\n\nРоль: ${role || "не уточнено"}\n`;
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, stringifyFrontmatter(fm, body), "utf8");
  return { path: relPath.split(path.sep).join("/"), created: true };
}

export async function listPeople(vaultRoot) {
  const dir = path.join(vaultRoot, "20_People");
  if (!(await pathExists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  const people = [];
  for (const file of files) {
    const { frontmatter } = await readNote(vaultRoot, path.join("20_People", file));
    people.push({
      file: `20_People/${file}`,
      name: file.replace(/_\([^)]*\)\.md$/, "").replace(/_/g, " "),
      role: frontmatter.role || null,
      aliases: frontmatter.aliases || [],
    });
  }
  return people;
}

/**
 * Поиск кандидатов-персон по имени/роли (заглушка под `gbrain.search`, см.
 * ТЗ §9.2 — в M2 семантический поиск через gbrain дополнит/заменит это).
 */
export async function searchPersonCandidates(vaultRoot, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const people = await listPeople(vaultRoot);
  return people
    .map((p) => {
      const haystack = [p.name, p.role, ...(p.aliases || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const score = haystack.includes(q) ? (p.name.toLowerCase() === q ? 1 : 0.7) : 0;
      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/** Дописать строку в _wiki/feedback.md хранилища (append-only, ТЗ §5, §8). */
export async function appendFeedback(vaultRoot, { layer, model, reaction, comment, ref }) {
  const filePath = path.join(vaultRoot, "_wiki", "feedback.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!(await pathExists(filePath))) {
    await fs.writeFile(
      filePath,
      "# Feedback log\n\n| timestamp (UTC) | layer | model | reaction | comment | ref |\n|---|---|---|---|---|---|\n",
      "utf8"
    );
  }
  const row = `| ${new Date().toISOString()} | ${layer || ""} | ${model || ""} | ${
    reaction || ""
  } | ${(comment || "").replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${ref || ""} |\n`;
  await fs.appendFile(filePath, row, "utf8");
  return { path: "_wiki/feedback.md" };
}

export async function listAllNotes(vaultRoot) {
  const results = [];
  for (const folder of NOTE_FOLDERS) {
    const dir = path.join(vaultRoot, folder);
    if (!(await pathExists(dir))) continue;
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    for (const f of files) results.push(path.join(folder, f).split(path.sep).join("/"));
  }
  return results;
}
