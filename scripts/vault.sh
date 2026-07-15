#!/usr/bin/env bash
# =============================================================================
# vault.sh — управление Obsidian-vault-ом второго мозга (см. ТЗ.md §6)
# =============================================================================
# Запускать внутри контейнера бота:
#   локально:  docker compose exec bot bash scripts/vault.sh <команда>
#   amvera:    в консоли сервиса  ->  bash /opt/second_brain/scripts/vault.sh <команда>
#
# Команды:
#   status                — количество заметок по папкам, размер vault-а
#   backup [путь.tar.gz]  — архив vault-а (по умолчанию /opt/data/vault-backup-<дата>.tar.gz)
#   reset                 — ПОЛНОСТЬЮ очистить vault (с подтверждением)
#
# ⚠ Записи в vault пишет только second-brain-mcp (см. Promts/08_obsidian_lint.md,
#   «Запреты») — этот скрипт только для просмотра состояния и обслуживания.
# =============================================================================
set -euo pipefail

VAULT_PATH="${VAULT_PATH:-/opt/data/vault}"
cmd="${1:-status}"; shift || true

case "${cmd}" in
  status)
    if [[ ! -d "${VAULT_PATH}" ]]; then
      echo "Vault ещё не создан: ${VAULT_PATH} (появится при первой записи second-brain-mcp)."
      exit 0
    fi
    echo "Vault: ${VAULT_PATH}"
    echo "Размер: $(du -sh "${VAULT_PATH}" 2>/dev/null | cut -f1)"
    echo ""
    for folder in Journal Decisions Documents Photos Handwriting People Wiki; do
      dir="${VAULT_PATH}/${folder}"
      if [[ -d "${dir}" ]]; then
        count=$(find "${dir}" -name '*.md' -type f | wc -l | tr -d ' ')
        printf '  %-12s %s заметок\n' "${folder}" "${count}"
      fi
    done
    ;;

  backup)
    [[ -d "${VAULT_PATH}" ]] || { echo "Vault не найден: ${VAULT_PATH}" >&2; exit 1; }
    out="${1:-/opt/data/vault-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
    tar -czf "${out}" -C "$(dirname "${VAULT_PATH}")" "$(basename "${VAULT_PATH}")"
    echo "Бэкап сохранён: ${out}"
    ;;

  reset)
    [[ -d "${VAULT_PATH}" ]] || { echo "Vault не найден: ${VAULT_PATH}, нечего очищать."; exit 0; }
    read -r -p "Очистить ВЕСЬ vault (${VAULT_PATH}) безвозвратно? [y/N] " ans
    case "${ans}" in
      y|Y|yes|да|Да)
        rm -rf "${VAULT_PATH}"
        echo "Vault очищен."
        ;;
      *) echo "Отменено."; exit 0 ;;
    esac
    ;;

  *)
    echo "Неизвестная команда: ${cmd}"; echo "Смотри шапку scripts/vault.sh"; exit 1 ;;
esac
