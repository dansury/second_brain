import fs from "node:fs/promises";
import path from "node:path";
import { vaultPath } from "./paths.js";

const feedbackPath = () => vaultPath("Wiki", "Feedback.md");
const HEADER = "# Feedback\n\nЖурнал реакций 👍/👎 на ответы бота — см. ТЗ §7.\n";

/**
 * Пишет запись 👍/👎 в Wiki/Feedback.md (слой 9, Promts/09_feedback_and_model_switch.md).
 * 👍 обычно вызывается без reason; 👎 — всегда с reason (после уточняющего вопроса).
 */
export async function recordFeedback({ rating, reason, model, layer, context }) {
  if (rating !== "up" && rating !== "down") {
    throw new Error('record_feedback: rating должен быть "up" или "down"');
  }

  await fs.mkdir(path.dirname(feedbackPath()), { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(feedbackPath(), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    existing = HEADER;
  }

  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const emoji = rating === "up" ? "👍" : "👎";
  const layerPart = layer ? `, слой: ${layer}` : "";

  const section = [
    `\n## ${stamp} — ${emoji} (${model || "модель не указана"}${layerPart})`,
    reason ? `**Причина:** ${reason}` : null,
    context ? `**Контекст:** ${context}` : null,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await fs.writeFile(feedbackPath(), existing + section, "utf8");
  return { path: feedbackPath() };
}
