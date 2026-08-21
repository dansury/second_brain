import fs from "node:fs/promises";
import path from "node:path";
import { vaultPath, FOLDERS, isoDate } from "./paths.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

export const DECISION_STATUSES = ["open", "outcome-good", "outcome-bad"];

// Принимает путь из search_vault ("Decisions/2026-03-02-otpusk.md"),
// wikilink ("[[Decisions/2026-03-02-otpusk]]") или голый slug — приводит
// к относительному пути внутри vault. Путь, начинающийся с другой папки
// vault-а (Journal/…), не переписывается — его отсеет проверка type.
function normalizeRef(ref) {
  let s = String(ref ?? "")
    .trim()
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "");
  if (!s) throw new Error("set_decision_outcome: пустой ref");
  if (!s.endsWith(".md")) s += ".md";
  let rel = path.normalize(s);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`set_decision_outcome: ref "${ref}" выходит за пределы vault`);
  }
  const vaultFolders = new Set(Object.values(FOLDERS));
  if (!vaultFolders.has(rel.split(path.sep)[0])) rel = path.join(FOLDERS.decision, rel);
  return rel;
}

/**
 * Проставляет исход прошлого решения (слой 4f, ТЗ §5.1): frontmatter
 * `status: open|outcome-good|outcome-bad` + секция «Исход» с заметкой
 * пользователя. Именно эти статусы делают запись прецедентом для слоя 4c.
 * Идемпотентно: повторный вызов с тем же статусом без note ничего не меняет.
 */
export async function setDecisionOutcome({ ref, status, note }) {
  if (!DECISION_STATUSES.includes(status)) {
    throw new Error(`set_decision_outcome: недопустимый status "${status}", ожидается один из: ${DECISION_STATUSES.join(", ")}`);
  }
  const rel = normalizeRef(ref);
  const filePath = vaultPath(rel);

  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `set_decision_outcome: запись "${rel}" не найдена — найдите её через search_vault (type: decision) и передайте поле path из результата`
      );
    }
    throw err;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  if (frontmatter.type !== "decision") {
    throw new Error(`set_decision_outcome: "${rel}" — это ${frontmatter.type || "запись без типа"}, а не decision`);
  }

  const previous = frontmatter.status || "open";
  const trimmedNote = String(note ?? "").trim();
  if (previous === status && !trimmedNote) {
    return { path: rel, previous, status, changed: false };
  }

  frontmatter.status = status;
  let nextBody = body.replace(/\s+$/, "");
  nextBody += `\n\n## Исход (${isoDate()})\n${trimmedNote || `status: ${previous} → ${status}`}\n`;

  await fs.writeFile(filePath, stringifyFrontmatter(frontmatter, nextBody), "utf8");
  return { path: rel, previous, status, changed: true };
}
