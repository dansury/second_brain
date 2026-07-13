import { promises as fs } from "node:fs";
import path from "node:path";
import { readNote, listAllNotes, listPeople } from "./vault.mjs";

const REQUIRED_FIELDS = {
  diary: ["type", "date", "source", "status"],
  fact: ["type", "date", "source", "status"],
  decision: ["type", "date", "source", "status", "people"],
  photo: ["type", "date", "source", "status"],
  document: ["type", "date", "source", "status"],
};

const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;

function looksLikePersonLink(target) {
  return /_\([^)]*\)$/.test(target.trim());
}

/**
 * Линт одной заметки (детерминированный, без LLM — ТЗ §7.2):
 *  1. Frontmatter содержит обязательные поля для своего `type`.
 *  2. Все [[ссылки]], похожие на персон (Имя_(роль)), существуют в 20_People/.
 *  3. Ссылки на персон, перечисленных в теле, отражены в frontmatter.people.
 */
export async function lintNote(vaultRoot, relPath) {
  const issues = [];
  const { frontmatter, body } = await readNote(vaultRoot, relPath);
  const type = frontmatter.type || "fact";
  const required = REQUIRED_FIELDS[type] || REQUIRED_FIELDS.fact;
  for (const field of required) {
    const val = frontmatter[field];
    const missing =
      val === undefined ||
      val === null ||
      val === "" ||
      (Array.isArray(val) && field !== "people" && val.length === 0);
    if (missing) {
      issues.push({ severity: "error", code: "missing_field", message: `Отсутствует обязательное поле frontmatter: ${field}` });
    }
  }

  const people = await listPeople(vaultRoot);
  const peopleFiles = new Set(people.map((p) => p.file.replace(/^20_People\//, "").replace(/\.md$/, "")));
  const linksInBody = new Set();
  let m;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const target = m[1].trim();
    linksInBody.add(target);
    if (looksLikePersonLink(target) && !peopleFiles.has(target)) {
      issues.push({
        severity: "error",
        code: "broken_person_link",
        message: `Ссылка на персону [[${target}]] не найдена в 20_People/ — похоже на не пройденную дизамбигуацию (см. ТЗ §3)`,
      });
    }
  }

  const declaredPeople = (frontmatter.people || []).map((p) =>
    String(p).replace(/^\[\[|\]\]$/g, "")
  );
  for (const target of linksInBody) {
    if (looksLikePersonLink(target) && peopleFiles.has(target) && !declaredPeople.includes(target)) {
      issues.push({
        severity: "warning",
        code: "people_frontmatter_out_of_sync",
        message: `[[${target}]] упомянут в тексте, но не перечислен в frontmatter.people`,
      });
    }
  }

  return { path: relPath, ok: issues.every((i) => i.severity !== "error"), issues };
}

/** Дубли персон: разные файлы с одинаковым (имя, роль) без учёта регистра/пробелов. */
async function findDuplicatePeople(vaultRoot) {
  const people = await listPeople(vaultRoot);
  const seen = new Map();
  const dups = [];
  for (const p of people) {
    const key = `${(p.name || "").trim().toLowerCase()}::${(p.role || "").trim().toLowerCase()}`;
    if (seen.has(key)) {
      dups.push({ severity: "error", code: "duplicate_person", message: `Похожие карточки персоны: ${seen.get(key)} и ${p.file} — возможно, один и тот же человек (см. ТЗ §3)` });
    } else {
      seen.set(key, p.file);
    }
  }
  return dups;
}

/**
 * Линт всего хранилища (или одной заметки) + запись отчёта в _meta/lint/.
 */
export async function lintVault(vaultRoot, { notePath } = {}) {
  const targets = notePath ? [notePath] : await listAllNotes(vaultRoot);
  const perNote = [];
  for (const rel of targets) {
    perNote.push(await lintNote(vaultRoot, rel));
  }
  const dupIssues = notePath ? [] : await findDuplicatePeople(vaultRoot);

  const allOk = perNote.every((n) => n.ok) && dupIssues.length === 0;
  const timestamp = new Date().toISOString();
  const reportLines = [
    `# Lint report — ${timestamp}`,
    "",
    allOk ? "Проблем не найдено." : "Найдены проблемы, требующие внимания:",
    "",
  ];
  for (const n of perNote) {
    if (n.issues.length === 0) continue;
    reportLines.push(`## ${n.path}`);
    for (const issue of n.issues) {
      reportLines.push(`- **${issue.severity}** (${issue.code}): ${issue.message}`);
    }
    reportLines.push("");
  }
  if (dupIssues.length) {
    reportLines.push("## 20_People/ (дубли)");
    for (const issue of dupIssues) reportLines.push(`- **${issue.severity}** (${issue.code}): ${issue.message}`);
    reportLines.push("");
  }

  const reportRelPath = path.join("_meta", "lint", `${timestamp.replace(/[:.]/g, "-")}.md`);
  const reportFullPath = path.join(vaultRoot, reportRelPath);
  await fs.mkdir(path.dirname(reportFullPath), { recursive: true });
  await fs.writeFile(reportFullPath, reportLines.join("\n"), "utf8");

  return {
    ok: allOk,
    checked: perNote.length,
    issues: perNote.flatMap((n) => n.issues.map((i) => ({ path: n.path, ...i }))).concat(
      dupIssues.map((i) => ({ path: "20_People/", ...i }))
    ),
    report_path: reportRelPath.split(path.sep).join("/"),
  };
}
