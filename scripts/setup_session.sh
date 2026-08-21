#!/usr/bin/env bash
# Session bootstrap: ставит зависимости MCP-сервера один раз на свежий
# контейнер. Идемпотентно и «мягко» — падение установки не должно ронять
# сессию. Порт scripts/setup_session.sh из GrowthProducer (там ставились
# Python dev-deps, здесь — bun-зависимости second-brain-mcp).
#
# Триггер: SessionStart-хук в .claude/settings.json. Можно запускать вручную.
set -euo pipefail

cd "$(dirname "$0")/.."

log() { printf '[setup] %s\n' "$*" >&2; }

MCP_DIR="tools/second-brain-mcp"

if [[ -f "${MCP_DIR}/package.json" ]]; then
  if command -v bun >/dev/null 2>&1; then
    if [[ ! -d "${MCP_DIR}/node_modules" ]]; then
      log "устанавливаю зависимости ${MCP_DIR} (bun)"
      (cd "${MCP_DIR}" && bun install --frozen-lockfile) || \
        (cd "${MCP_DIR}" && bun install) || log "bun install не удался (не фатально)"
    fi
  else
    log "bun не найден — тесты MCP-сервера в этой сессии недоступны"
  fi
fi

exit 0
