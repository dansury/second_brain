#!/usr/bin/env node
import { ensureVault, vaultRootFromEnv } from "./vault.mjs";
import { serve } from "./mcp.mjs";

const VERSION = "0.1.0";

async function main() {
  const cmd = process.argv[2];
  const vaultRoot = vaultRootFromEnv();

  switch (cmd) {
    case "serve":
      serve({ vaultRoot });
      break;

    case "init": {
      const created = await ensureVault(vaultRoot);
      console.log(`[secondbrain] Хранилище готово: ${vaultRoot}`);
      for (const dir of created) console.log(`  - ${dir}`);
      break;
    }

    case "--version":
    case "-v":
      console.log(VERSION);
      break;

    default:
      console.log(
        [
          "secondbrain — MCP-сервер second_brain (см. ../ТЗ.md §9)",
          "",
          "Использование:",
          "  secondbrain init      Создать структуру Obsidian-хранилища (идемпотентно)",
          "  secondbrain serve     Запустить MCP-сервер на stdio",
          "  secondbrain --version Версия",
        ].join("\n")
      );
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[secondbrain] Фатальная ошибка:", err);
  process.exitCode = 1;
});
