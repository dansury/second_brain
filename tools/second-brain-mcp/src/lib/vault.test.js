import { test, expect, describe, beforeAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// VAULT_PATH определяет модуль paths.js на верхнем уровне при первом
// импорте — поэтому создаём временный vault и задаём env ДО динамического
// импорта библиотек (см. tools/second-brain-mcp/README.md).
let vaultDir;
let characters, entries, feedback, handwriting, decisions;

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "second-brain-vault-"));
  process.env.VAULT_PATH = vaultDir;
  characters = await import("./characters.js");
  entries = await import("./entries.js");
  feedback = await import("./feedback.js");
  handwriting = await import("./handwriting.js");
  decisions = await import("./decisions.js");
});

describe("characters", () => {
  test("upsert creates a new person file, lookup finds it", async () => {
    const created = await characters.upsertCharacter({ name: "Иван Петров", role: "коллега", aliases: ["Ваня"] });
    expect(created.created).toBe(true);
    expect(created.link).toBe("[[Иван_Петров_(коллега)]]");

    const candidates = await characters.lookupCharacter({ name: "Иван Петров", role: "коллега" });
    expect(candidates[0].link).toBe("[[Иван_Петров_(коллега)]]");
    expect(candidates[0].score).toBeGreaterThan(0.9);
  });

  test("upsert is idempotent and merges aliases", async () => {
    await characters.upsertCharacter({ name: "Иван Петров", role: "коллега", aliases: ["Ванька"] });
    const files = await fs.readdir(path.join(vaultDir, "People"));
    expect(files.filter((f) => f.includes("Иван_Петров"))).toHaveLength(1);

    const candidates = await characters.lookupCharacter({ name: "Иван", role: "коллега" });
    expect(candidates[0].aliases).toEqual(expect.arrayContaining(["Ваня", "Ванька"]));
  });

  test("different role on same name still finds candidate but lower score", async () => {
    const candidates = await characters.lookupCharacter({ name: "Иван Петров", role: "сосед" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].score).toBeLessThan(1);
  });
});

describe("entries", () => {
  test("journal entries for the same day append into one file", async () => {
    const first = await entries.writeEntry({
      type: "journal",
      body: "Первая запись дня.",
      links: ["Иван_Петров_(коллега)"],
      date: "2026-07-13",
    });
    expect(first.created).toBe(true);

    const second = await entries.writeEntry({
      type: "journal",
      body: "Вторая запись того же дня.",
      date: "2026-07-13",
    });
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);

    const raw = await fs.readFile(first.path, "utf8");
    expect(raw).toContain("Первая запись дня.");
    expect(raw).toContain("Вторая запись того же дня.");
    expect(raw).toContain("[[Иван_Петров_(коллега)]]");
  });

  test("decision entries are one file per slug and searchable", async () => {
    await entries.writeEntry({
      type: "decision",
      frontmatter: { status: "open", title: "переход в новый проект" },
      body: "Стоит ли соглашаться на переход в новый проект с Иваном?",
      links: ["Иван_Петров_(коллега)"],
      date: "2026-07-13",
    });

    const results = await entries.searchVault({ query: "переход", type: "decision" });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("open");
  });
});

describe("decisions (слой 4f)", () => {
  test("set_decision_outcome проставляет исход и дописывает секцию «Исход»", async () => {
    const { path: absPath } = await entries.writeEntry({
      type: "decision",
      frontmatter: { title: "отпуск", status: "open" },
      body: "Стоит ли брать отпуск в июле?",
      date: "2026-07-01",
    });
    const rel = path.relative(vaultDir, absPath);

    const result = await decisions.setDecisionOutcome({
      ref: rel,
      status: "outcome-good",
      note: "Отпуск удался, вернулся отдохнувшим",
    });
    expect(result.changed).toBe(true);
    expect(result.previous).toBe("open");

    const raw = await fs.readFile(absPath, "utf8");
    expect(raw).toContain("status: outcome-good");
    expect(raw).toContain("## Исход (");
    expect(raw).toContain("Отпуск удался");
  });

  test("повторный вызов с тем же статусом без note — no-op", async () => {
    const rel = "Decisions/2026-07-01-отпуск.md";
    const before = await fs.readFile(path.join(vaultDir, rel), "utf8");
    const result = await decisions.setDecisionOutcome({ ref: rel, status: "outcome-good" });
    expect(result.changed).toBe(false);
    expect(await fs.readFile(path.join(vaultDir, rel), "utf8")).toBe(before);
  });

  test("принимает wikilink и голый slug без Decisions/ и .md", async () => {
    await entries.writeEntry({
      type: "decision",
      frontmatter: { title: "переезд", status: "open" },
      body: "Переезжать ли в другой город?",
      date: "2026-07-02",
    });

    const viaWikilink = await decisions.setDecisionOutcome({
      ref: "[[Decisions/2026-07-02-переезд]]",
      status: "outcome-bad",
      note: "Пожалел через месяц",
    });
    expect(viaWikilink.changed).toBe(true);

    const viaSlug = await decisions.setDecisionOutcome({ ref: "2026-07-02-переезд", status: "outcome-bad" });
    expect(viaSlug.changed).toBe(false);
    expect(viaSlug.previous).toBe("outcome-bad");
  });

  test("отклоняет не-decision записи, неизвестный ref и недопустимый статус", async () => {
    expect(decisions.setDecisionOutcome({ ref: "Journal/2026/07/2026-07-13.md", status: "outcome-good" })).rejects.toThrow(
      /а не decision/
    );
    expect(decisions.setDecisionOutcome({ ref: "Decisions/нет-такого.md", status: "outcome-good" })).rejects.toThrow(
      /не найдена/
    );
    expect(decisions.setDecisionOutcome({ ref: "2026-07-02-переезд", status: "победа" })).rejects.toThrow(
      /недопустимый status/
    );
    expect(decisions.setDecisionOutcome({ ref: "../за-пределами", status: "open" })).rejects.toThrow(/пределы vault/);
  });

  test("search_vault фильтрует по status — решённые прецеденты для слоя 4c", async () => {
    const good = await entries.searchVault({ query: "", type: "decision", status: "outcome-good" });
    expect(good.map((r) => r.path)).toContain("Decisions/2026-07-01-отпуск.md");
    expect(good.every((r) => r.status === "outcome-good")).toBe(true);

    const open = await entries.searchVault({ query: "", type: "decision", status: "open" });
    expect(open.map((r) => r.path)).not.toContain("Decisions/2026-07-01-отпуск.md");
    expect(open.map((r) => r.path)).toContain("Decisions/2026-07-13-переход_в_новый_проект.md");
  });
});

describe("feedback", () => {
  test("records down-vote with reason and model", async () => {
    const result = await feedback.recordFeedback({
      rating: "down",
      reason: "прогноз не учёл историю",
      model: "anthropic/claude-opus-4.6",
      layer: "04e",
    });
    const raw = await fs.readFile(result.path, "utf8");
    expect(raw).toContain("👎");
    expect(raw).toContain("прогноз не учёл историю");
    expect(raw).toContain("anthropic/claude-opus-4.6");
  });
});

describe("handwriting", () => {
  test("remembers and retrieves descriptive notes, de-duplicated", async () => {
    await handwriting.rememberHandwriting({ person: "Иван_Петров_(коллега)", notes: ["заглавная Т с засечкой"] });
    await handwriting.rememberHandwriting({ person: "Иван_Петров_(коллега)", notes: ["заглавная Т с засечкой", "слитное 'ст'"] });

    const profile = await handwriting.getHandwritingProfile({ person: "Иван_Петров_(коллега)" });
    expect(profile.found).toBe(true);
    expect(profile.notes).toHaveLength(2);
  });

  test("missing profile returns found:false", async () => {
    const profile = await handwriting.getHandwritingProfile({ person: "Неизвестный_Человек" });
    expect(profile.found).toBe(false);
    expect(profile.notes).toEqual([]);
  });
});
