/**
 * Пути, не зависящие от vault-а: корень репозитория (config/*.json) и том
 * с рантайм-кэшами. Отдельно от paths.js намеренно — тот фиксирует VAULT_PATH
 * на уровне модуля, а модели/цены нужны и там, где vault не поднят.
 */

import path from "node:path";

/** Корень репозитория second_brain. SECOND_BRAIN_DIR задаёт entrypoint. */
export function repoPath(...segments) {
  const root =
    process.env.SECOND_BRAIN_DIR ||
    path.resolve(new URL("../../../..", import.meta.url).pathname);
  return path.join(root, ...segments);
}

/** Том для рантайм-кэшей (free_models.json). По умолчанию — родитель vault-а. */
export function dataPath(...segments) {
  const vault = process.env.VAULT_PATH || "/opt/data/vault";
  const root = process.env.DATA_DIR || path.dirname(vault);
  return path.join(root, ...segments);
}
