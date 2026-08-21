import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// paths.js читает VAULT_PATH при каждом обращении, так что временный vault
// этого файла не конфликтует с vault.test.js в общем процессе bun test.
let vaultDir;
let history;

/** Кусок разметки t.me/s: один пост канала. */
function postBlock({ username, id, text, date, author }) {
  return `
<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${username}/${id}" data-view="eyJ4In0">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/${username}"><span dir="auto">Канал</span></a></div>
    ${author ? `<div class="tgme_widget_message_from_author" dir="auto">${author}</div>` : ""}
    <div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>
    <div class="tgme_widget_message_footer compact js-message_footer">
      <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${username}/${id}"><time datetime="${date}" class="time">10:12</time></a></span>
    </div>
  </div>
</div>`;
}

function page(username, posts) {
  return `<!doctype html><html><body><main class="tgme_channel_history js-message_history">${posts
    .map((p) => postBlock({ username, ...p }))
    .join("\n")}</main></body></html>`;
}

/** Канал из `total` постов, отдаваемый страницами по `perPage`, как t.me/s. */
function fakeChannel(username, total, perPage = 3) {
  const all = Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    text: `Пост номер ${i + 1} про <b>работу</b> &amp; отдых`,
    date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T10:12:03+00:00`,
  }));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const before = Number(new URL(url).searchParams.get("before") || 0);
    const upTo = before > 0 ? all.filter((p) => p.id < before) : all;
    const slice = upTo.slice(-perPage);
    return { ok: true, text: async () => page(username, slice) };
  };
  return { fetchImpl, calls, all };
}

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "second-brain-history-"));
  process.env.VAULT_PATH = vaultDir;
  history = await import("./history.js");
});

beforeEach(async () => {
  await fs.rm(path.join(vaultDir, "Journal"), { recursive: true, force: true });
  await fs.rm(path.join(vaultDir, ".state"), { recursive: true, force: true });
});

describe("normalizeChat", () => {
  test("принимает @username, ссылку и превью-ссылку", () => {
    expect(history.normalizeChat("@my_diary")).toBe("my_diary");
    expect(history.normalizeChat("https://t.me/my_diary")).toBe("my_diary");
    expect(history.normalizeChat("t.me/s/my_diary/42")).toBe("my_diary");
  });

  test("приватная invite-ссылка отвергается с подсказкой про экспорт", () => {
    expect(() => history.normalizeChat("https://t.me/+AbCdEf")).toThrow(/import_chat_history_file/);
    expect(() => history.normalizeChat("")).toThrow();
  });
});

describe("parseHistoryPage", () => {
  test("вытаскивает id, текст, ссылку и дату, чинит html-сущности", () => {
    const html = page("my_diary", [
      { id: 7, text: "Встретился с Иваном<br>обсудили &laquo;проект&raquo; &amp; сроки", date: "2026-07-13T10:12:03+00:00" },
    ]);
    const [post] = history.parseHistoryPage(html, "my_diary");
    expect(post.msgId).toBe(7);
    expect(post.url).toBe("https://t.me/my_diary/7");
    expect(post.text).toBe("Встретился с Иваном\nобсудили «проект» & сроки");
    expect(post.datetime).toBe("2026-07-13T10:12:03+00:00");
  });

  test("пропускает чужие посты и сообщения без текста (фото/сервисные)", () => {
    const html =
      page("my_diary", [{ id: 1, text: "Есть текст", date: "2026-07-01T09:00:00+00:00" }]) +
      '<div data-post="other_channel/99"><div class="tgme_widget_message_text">чужое</div></div>' +
      '<div data-post="my_diary/2"><div class="tgme_widget_message_photo_wrap"></div></div>';
    const posts = history.parseHistoryPage(html, "my_diary");
    expect(posts.map((p) => p.msgId)).toEqual([1]);
  });

  test("автора сообщения в группе берёт из from_author, а не из имени канала", () => {
    const html = page("my_group", [
      { id: 3, text: "Сообщение в группе", date: "2026-07-02T09:00:00+00:00", author: "Иван Петров" },
    ]);
    expect(history.parseHistoryPage(html, "my_group")[0].author).toBe("Иван Петров");
    const noAuthor = page("my_diary", [{ id: 4, text: "Пост канала", date: "2026-07-02T09:00:00+00:00" }]);
    expect(history.parseHistoryPage(noAuthor, "my_diary")[0].author).toBe("");
  });
});

describe("fetchChatHistory", () => {
  test("пагинация ?before= собирает всю историю, новые первыми", async () => {
    const { fetchImpl, calls } = fakeChannel("my_diary", 10, 3);
    const { posts } = await history.fetchChatHistory("my_diary", { fetchImpl });
    expect(posts).toHaveLength(10);
    expect(posts[0].msgId).toBe(10);
    expect(posts.at(-1).msgId).toBe(1);
    expect(calls[0]).toBe("https://t.me/s/my_diary");
    expect(calls[1]).toContain("before=8");
  });

  test("limit обрезает до самых свежих, since_id — докачка только новых", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 10, 3);
    const limited = await history.fetchChatHistory("my_diary", { limit: 4, fetchImpl });
    expect(limited.posts.map((p) => p.msgId)).toEqual([10, 9, 8, 7]);

    const since = await history.fetchChatHistory("my_diary", { sinceId: 8, fetchImpl });
    expect(since.posts.map((p) => p.msgId)).toEqual([10, 9]);
  });

  test("сетевая ошибка не роняет импорт: отдаётся собранное + warning", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 10, 3);
    let n = 0;
    const flaky = async (url) => {
      n += 1;
      if (n > 2) throw new Error("boom");
      return fetchImpl(url);
    };
    const { posts, warnings } = await history.fetchChatHistory("my_diary", { fetchImpl: flaky });
    expect(posts.length).toBe(6);
    expect(warnings.some((w) => w.startsWith("fetch_failed"))).toBe(true);
  });
});

describe("importChatHistory", () => {
  test("вся история попадает в дневник своими датами, с постоянными ссылками", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 5, 2);
    const result = await history.importChatHistory({ chat: "@my_diary", fetchImpl });

    expect(result.imported).toBe(5);
    expect(result.max_msg_id).toBe(5);
    expect(result.recent[0].msg_id).toBe(5);

    const dayFile = path.join(vaultDir, "Journal", "2026", "07", "2026-07-01.md");
    const content = await fs.readFile(dayFile, "utf8");
    expect(content).toContain("## 10:12 — @my_diary/1");
    expect(content).toContain("https://t.me/my_diary/1");
    expect(content).toContain("source: telegram-history");
    expect(content).toContain("via: tme-preview");
    expect(content).toContain("Пост номер 1 про работу & отдых");
  });

  test("повторный импорт идемпотентен (состояние импорта)", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 5, 2);
    await history.importChatHistory({ chat: "my_diary", fetchImpl });
    const again = await history.importChatHistory({ chat: "my_diary", fetchImpl });
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(5);

    const content = await fs.readFile(path.join(vaultDir, "Journal", "2026", "07", "2026-07-01.md"), "utf8");
    expect(content.match(/## 10:12 — @my_diary\/1/g)).toHaveLength(1);
  });

  test("потеря состояния импорта не даёт дублей: якорь — ссылка в файле дня", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 3, 2);
    await history.importChatHistory({ chat: "my_diary", fetchImpl });
    await fs.rm(path.join(vaultDir, ".state"), { recursive: true, force: true });

    const again = await history.importChatHistory({ chat: "my_diary", fetchImpl });
    expect(again.imported).toBe(0);
    const content = await fs.readFile(path.join(vaultDir, "Journal", "2026", "07", "2026-07-02.md"), "utf8");
    expect(content.match(/## 10:12 — @my_diary\/2/g)).toHaveLength(1);
  });

  test("dry_run считает, но ничего не пишет", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 4, 2);
    const result = await history.importChatHistory({ chat: "my_diary", dryRun: true, fetchImpl });
    expect(result.imported).toBe(4);
    expect(result.dry_run).toBe(true);
    expect(await fs.readdir(path.join(vaultDir, "Journal")).catch(() => null)).toBeNull();
  });

  test("приватный канал без превью: пустой результат с подсказкой, без исключения", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "" });
    const result = await history.importChatHistory({ chat: "private_one", fetchImpl });
    expect(result.imported).toBe(0);
    expect(result.hint).toContain("import_chat_history_file");
  });

  test("history_import_status показывает диапазон импортированного", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 5, 2);
    await history.importChatHistory({ chat: "my_diary", fetchImpl });
    const status = await history.historyImportStatus({ chat: "@my_diary" });
    expect(status.imported).toBe(5);
    expect(status.min_msg_id).toBe(1);
    expect(status.max_msg_id).toBe(5);
  });
});

describe("importChatHistoryFile (экспорт Telegram Desktop)", () => {
  const exportJson = {
    name: "Мой дневник",
    type: "private_channel",
    id: 123,
    messages: [
      { id: 1, type: "service", action: "create_channel", date: "2026-06-01T08:00:00" },
      { id: 2, type: "message", date: "2026-06-02T09:30:00", from: "Дан", text: "Первая запись" },
      {
        id: 3,
        type: "message",
        date: "2026-06-03T19:05:00",
        from: "Дан",
        text: ["Сомневаюсь насчёт ", { type: "bold", text: "перехода" }, " в новый проект"],
      },
      { id: 4, type: "message", date: "2026-06-04T10:00:00", from: "Дан", text: "" },
    ],
  };

  test("плоский и составной text, сервисные и пустые сообщения пропущены", () => {
    const { title, posts } = history.parseExportJson(JSON.stringify(exportJson));
    expect(title).toBe("Мой дневник");
    expect(posts.map((p) => p.msgId)).toEqual([2, 3]);
    expect(posts[1].text).toBe("Сомневаюсь насчёт перехода в новый проект");
  });

  test("импорт из файла пишет в дневник и запоминает состояние", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-export-"));
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(exportJson), "utf8");

    const result = await history.importChatHistoryFile({ file: dir, chat: "my_private" });
    expect(result.imported).toBe(2);
    expect(result.via).toBe("tg-export");

    const content = await fs.readFile(path.join(vaultDir, "Journal", "2026", "06", "2026-06-03.md"), "utf8");
    expect(content).toContain("**Автор:** Дан");
    expect(content).toContain("Сомневаюсь насчёт перехода в новый проект");

    const again = await history.importChatHistoryFile({ file: path.join(dir, "result.json"), chat: "my_private" });
    expect(again.imported).toBe(0);
  });

  test("несуществующий файл — понятная ошибка", async () => {
    await expect(history.importChatHistoryFile({ file: "/nope/result.json" })).rejects.toThrow(/не найден/);
  });
});

describe("восстановление состояния импорта", () => {
  test("после потери .state повторный прогон восстанавливает id из файлов дня", async () => {
    const { fetchImpl } = fakeChannel("my_diary", 3, 2);
    await history.importChatHistory({ chat: "my_diary", fetchImpl });
    await fs.rm(path.join(vaultDir, ".state"), { recursive: true, force: true });

    await history.importChatHistory({ chat: "my_diary", fetchImpl });
    const status = await history.historyImportStatus({ chat: "my_diary" });
    expect(status.imported).toBe(3);
    expect(status.max_msg_id).toBe(3);
  });
});
