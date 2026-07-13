import { test, expect, describe } from "bun:test";
import { stringSimilarity } from "./similarity.js";

describe("stringSimilarity", () => {
  test("identical strings score 1", () => {
    expect(stringSimilarity("Иван Петров", "иван петров")).toBe(1);
  });

  test("unrelated strings score low", () => {
    expect(stringSimilarity("Иван Петров", "Мария Сидорова")).toBeLessThan(0.4);
  });

  test("near-miss typo scores high but not perfect", () => {
    const score = stringSimilarity("Иван Петров", "Иван Петров ");
    expect(score).toBeGreaterThan(0.9);
  });
});
