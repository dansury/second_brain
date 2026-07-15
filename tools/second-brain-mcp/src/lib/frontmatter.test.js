import { test, expect, describe } from "bun:test";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

describe("frontmatter", () => {
  test("round-trips scalars and arrays", () => {
    const fm = {
      type: "decision",
      date: "2026-07-13",
      people: ["[[Иван_Петров_(коллега)]]"],
      tags: ["работа", "переход"],
      status: "open",
    };
    const content = stringifyFrontmatter(fm, "\nТекст записи.\n");
    const parsed = parseFrontmatter(content);

    expect(parsed.frontmatter.type).toBe("decision");
    expect(parsed.frontmatter.date).toBe("2026-07-13");
    expect(parsed.frontmatter.people).toEqual(["[[Иван_Петров_(коллега)]]"]);
    expect(parsed.frontmatter.tags).toEqual(["работа", "переход"]);
    expect(parsed.body.trim()).toBe("Текст записи.");
  });

  test("handles empty arrays and content without frontmatter", () => {
    const content = stringifyFrontmatter({ tags: [] }, "\nтело\n");
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.tags).toEqual([]);

    const plain = parseFrontmatter("просто текст без frontmatter");
    expect(plain.frontmatter).toEqual({});
    expect(plain.body).toBe("просто текст без frontmatter");
  });
});
