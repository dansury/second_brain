// Сквозная самопроверка secondbrain без MCP-транспорта и без сети (см. README.md).
// node test/run.mjs

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import assert from "node:assert/strict";

import { ensureVault } from "../src/vault.mjs";
import { tools } from "../src/tools/index.mjs";

async function main() {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secondbrain-test-"));
  const ctx = { vaultRoot };
  let step = "";

  try {
    step = "vault_init";
    const init = await tools.vault_init.handler({}, ctx);
    assert.ok(init.dirs.includes("20_People"));

    step = "vault_write_note (со ссылкой на ещё не существующего персонажа)";
    const note1 = await tools.vault_write_note.handler(
      {
        folder: "10_Diary",
        title: "Разговор с Иваном",
        body: "Обсудили переход в проект с [[Иван_Петров_(начальник)]].",
        frontmatter: {
          type: "diary",
          date: "2026-07-13",
          source: "telegram_dm",
          status: "draft",
        },
      },
      ctx
    );
    assert.ok(note1.path.startsWith("10_Diary/"));

    step = "vault_lint (должен найти broken_person_link)";
    const lint1 = await tools.vault_lint.handler({ note_path: note1.path }, ctx);
    assert.equal(lint1.ok, false, "линт должен провалиться на битой ссылке на персону");
    assert.ok(lint1.issues.some((i) => i.code === "broken_person_link"));

    step = "person_search_candidates (пусто, персонажа ещё нет)";
    const search1 = await tools.person_search_candidates.handler({ query: "Иван" }, ctx);
    assert.equal(search1.candidates.length, 0);

    step = "person_ensure (создать персонажа)";
    const person = await tools.person_ensure.handler(
      { name: "Иван Петров", role: "начальник" },
      ctx
    );
    assert.equal(person.created, true);
    assert.equal(person.path, "20_People/Иван_Петров_(начальник).md");

    step = "vault_lint повторно (теперь без broken_person_link, но с people_frontmatter_out_of_sync)";
    const lint2 = await tools.vault_lint.handler({ note_path: note1.path }, ctx);
    assert.ok(!lint2.issues.some((i) => i.code === "broken_person_link"));
    assert.ok(lint2.issues.some((i) => i.code === "people_frontmatter_out_of_sync"));

    step = "vault_write_note (с корректным frontmatter.people)";
    const note2 = await tools.vault_write_note.handler(
      {
        folder: "10_Diary",
        title: "Разговор с Иваном (обновлено)",
        body: "Обсудили переход в проект с [[Иван_Петров_(начальник)]].",
        frontmatter: {
          type: "diary",
          date: "2026-07-13",
          people: ["Иван_Петров_(начальник)"],
          source: "telegram_dm",
          status: "confirmed",
        },
      },
      ctx
    );
    const lint3 = await tools.vault_lint.handler({ note_path: note2.path }, ctx);
    assert.equal(lint3.ok, true, "после синхронизации people[] линт должен пройти");

    step = "person_search_candidates (теперь находит)";
    const search2 = await tools.person_search_candidates.handler({ query: "Иван" }, ctx);
    assert.equal(search2.candidates.length, 1);
    assert.equal(search2.candidates[0].file, "20_People/Иван_Петров_(начальник).md");

    step = "feedback_record";
    const fb = await tools.feedback_record.handler(
      {
        layer: "L5",
        model: "anthropic/claude-opus-4.6",
        reaction: "👎",
        comment: "слишком уверенно для скудной истории",
        ref: `[[${note2.path.replace(/\.md$/, "")}]]`,
      },
      ctx
    );
    const fbContent = await fs.readFile(path.join(vaultRoot, fb.path), "utf8");
    assert.ok(fbContent.includes("слишком уверенно"));

    step = "model_prices (сортировка по возрастанию)";
    const prices = await tools.model_prices.handler({ provider: "openrouter" });
    for (let i = 1; i < prices.models.length; i++) {
      assert.ok(prices.models[i].prompt_usd_per_1k >= prices.models[i - 1].prompt_usd_per_1k);
    }

    step = "layers_list (читает Promts/*.md)";
    const layers = await tools.layers_list.handler({}, ctx);
    assert.ok(layers.layers.length >= 10, `ожидалось >=10 промтов, получено ${layers.layers.length}`);
    assert.ok(layers.layers.some((l) => l.layer === "L5"));

    step = "vault_lint без note_path (дубли персон)";
    await tools.person_ensure.handler({ name: "Иван Петров", role: "начальник" }, ctx); // no-op, уже есть
    await fs.writeFile(
      path.join(vaultRoot, "20_People", "Иван Петров_(начальник).md"),
      "---\ntype: person\nrole: начальник\n---\n\ndup\n",
      "utf8"
    );
    const lintAll = await tools.vault_lint.handler({}, ctx);
    assert.ok(lintAll.issues.some((i) => i.code === "duplicate_person"));

    console.log(`OK — все ${9} шагов прошли (vault: ${vaultRoot})`);
  } catch (err) {
    console.error(`FAIL на шаге "${step}":`, err);
    process.exitCode = 1;
    return;
  } finally {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  }
}

main();
