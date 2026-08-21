import path from "node:path";

/**
 * Корень vault-а читается из окружения при каждом обращении, а не
 * защёлкивается при импорте модуля: так путь остаётся правдой и в тестах,
 * где несколько файлов делят один процесс, и при смене VAULT_PATH на лету.
 */
export function vaultRoot() {
  return process.env.VAULT_PATH || "/opt/data/vault";
}

export const FOLDERS = {
  journal: "Journal",
  decision: "Decisions",
  document: "Documents",
  "photo-people": "Photos",
  handwriting: "Handwriting",
};

/** Slug: unicode-aware (kirillitsa included), stable, filesystem-safe. */
export function slugify(input) {
  const s = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return s || "item";
}

/** "Иван Петров", "коллега" -> "Иван_Петров_(коллега)" (без расширения). */
export function personSlug(name, role) {
  const namePart = String(name ?? "").trim().replace(/\s+/g, "_");
  const rolePart = String(role ?? "").trim();
  return rolePart ? `${namePart}_(${rolePart})` : namePart;
}

export function personFilePath(name, role) {
  return vaultPath("People", `${personSlug(name, role)}.md`);
}

export function handwritingFilePath(personLabel) {
  const label = String(personLabel ?? "").replace(/^\[\[|\]\]$/g, "");
  return vaultPath("Handwriting", `${slugify(label)}_почерк.md`);
}

export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function isoTime(d = new Date()) {
  return d.toISOString().slice(11, 16); // HH:MM
}

export function vaultPath(...segments) {
  return path.join(vaultRoot(), ...segments);
}

export function toWikiLink(label) {
  const s = String(label ?? "").trim();
  if (!s) return s;
  return s.startsWith("[[") ? s : `[[${s}]]`;
}
