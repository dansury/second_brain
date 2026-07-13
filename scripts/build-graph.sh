#!/usr/bin/env bash
# =============================================================================
# build-graph.sh — построить граф знаний Grafify по этому репозиторию
# =============================================================================
# Grafify анализирует код локально (tree-sitter) и создаёт graphify-out/graph.json,
# который затем отдаётся агенту как MCP-инструмент (GRAFIFY_ENABLED=true).
#
# Использование:
#   scripts/build-graph.sh [путь_к_проекту]   # по умолчанию — текущая папка
#
# Требуется установленный graphify:
#   uv tool install graphifyy   # или: pipx install graphifyy
# =============================================================================
set -euo pipefail

TARGET="${1:-.}"

if ! command -v graphify >/dev/null 2>&1; then
  echo "graphify не установлен. Установите: uv tool install graphifyy (или pipx install graphifyy)" >&2
  exit 1
fi

echo "[grafify] Строю граф по: ${TARGET} (запись в ${TARGET}/graphify-out/)"
graphify extract "${TARGET}"

GRAPH="${TARGET%/}/graphify-out/graph.json"
echo "[grafify] Готово: ${GRAPH}"
echo "[grafify] Включите MCP: GRAFIFY_ENABLED=true, GRAFIFY_GRAPH_PATH=\$(realpath ${GRAPH})"
