#!/usr/bin/env bash
# =============================================================================
# memory.sh — управление долговременной памятью (gbrain)
# =============================================================================
# Запускать внутри контейнера бота (там установлен gbrain и лежит мозг):
#   локально:  docker compose exec bot bash scripts/memory.sh <команда>
#   amvera:    в консоли сервиса  ->  bash /opt/second_brain/scripts/memory.sh <команда>
#
# Команды:
#   status              — показать состояние мозга (gbrain doctor)
#   forget <fact-id>    — забыть один факт по id
#   search <запрос>     — найти факты (чтобы узнать их id)
#   clear               — ПОЛНОСТЬЮ очистить память (wipe + переинициализация)
#
# ⚠ Проще всего чистить память прямо из Telegram — словами боту:
#     «забудь, что …»  /  «удали из памяти …»
#   Агент вызовет инструмент forget_fact у gbrain-MCP. Скрипт нужен для
#   массовой очистки и обслуживания.
# =============================================================================
set -euo pipefail

export GBRAIN_HOME="${GBRAIN_HOME:-/opt/data/gbrain}"
export HOME="${HERMES_HOME:-/opt/data}"

cmd="${1:-status}"; shift || true

if ! command -v gbrain >/dev/null 2>&1; then
  echo "gbrain не найден. Запускайте скрипт внутри контейнера бота." >&2
  exit 1
fi

case "${cmd}" in
  status)  gbrain doctor ;;
  search)  gbrain recall "$@" ;;
  forget)  [ -n "${1:-}" ] || { echo "usage: memory.sh forget <fact-id>"; exit 1; }
           gbrain forget "$1" ;;
  clear)
    read -r -p "Очистить ВСЮ память безвозвратно? [y/N] " ans
    case "${ans}" in
      y|Y|yes|да|Да)
        echo "Полная очистка памяти (reinit-pglite)…"
        gbrain reinit-pglite --yes 2>&1 || gbrain reinit-pglite
        echo "Память очищена."
        ;;
      *) echo "Отменено."; exit 0 ;;
    esac
    ;;
  *) echo "Неизвестная команда: ${cmd}"; echo "Смотри шапку scripts/memory.sh"; exit 1 ;;
esac
