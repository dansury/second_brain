#!/usr/bin/env bash
# =============================================================================
# state-snapshot.sh — снимки и откат накопленного состояния второго мозга
# =============================================================================
# Обновление ядра hermes меняет КОД, но данные живут в томе /opt/data и
# переживают пересборку образа: мозг gbrain (память и её индекс поиска), vault
# Obsidian, граф Grafify, состояние шлюза. Этот скрипт снимает их целиком,
# чтобы неудачное обновление можно было откатить не только по версии образа
# (scripts/hermes-update.sh rollback), но и по данным.
#
# Снимок делается АВТОМАТИЧЕСКИ при каждой смене версии ядра — docker/entrypoint.sh
# вызывает `create` до старта сервисов, то есть до того, как новая версия
# впервые тронет том.
#
# Команды (запускать внутри контейнера бота):
#   create [причина]     — снять снимок текущего состояния
#   list                 — список снимков (id, дата, размер, версия ядра)
#   restore <id|last>    — восстановить состояние из снимка
#   prune [сколько]      — оставить N последних снимков (по умолчанию 5)
#   verify <id>          — проверить целостность архива снимка
#
# Коды возврата create: 0 — снимок сделан, 20 — пропущен по лимиту размера,
# иное — сбой (entrypoint различает их: см. run_snapshot).
#
# Переменные:
#   STATE_BACKUP_ENABLED=true|false   авто-снимок при смене версии (по умолчанию true)
#   STATE_BACKUP_KEEP=5               сколько снимков хранить
#   STATE_BACKUP_MAX_MB=1024          верхний предел размера данных для снимка
#
# Локально:  docker compose exec bot bash /opt/second_brain/scripts/state-snapshot.sh list
# amvera:    в консоли сервиса  ->  bash /opt/second_brain/scripts/state-snapshot.sh list
# =============================================================================
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/opt/data}"
BACKUP_DIR="${STATE_BACKUP_DIR:-${HERMES_HOME}/backups}"
STATE_FILE="${HERMES_HOME}/.second_brain/state.json"
BASE_IMAGE_FILE="${BASE_IMAGE_FILE:-/opt/second_brain/BASE_IMAGE}"
KEEP="${STATE_BACKUP_KEEP:-5}"
MAX_MB="${STATE_BACKUP_MAX_MB:-1024}"

# Что НЕ попадает в снимок: сами снимки (иначе рекурсия) и мусор рантайма.
EXCLUDES=(
  "--exclude=./backups"
  "--exclude=./*.tar.gz"
  "--exclude=./tmp"
  "--exclude=./.cache"
)

log() { printf '[snapshot] %s\n' "$*" >&2; }
die() { printf '[snapshot] ОШИБКА: %s\n' "$*" >&2; exit 1; }

# Версия ядра, ЗАШИТАЯ В ТЕКУЩИЙ ОБРАЗ.
image_base_image() {
  [[ -f "${BASE_IMAGE_FILE}" ]] && tr -d '\n' < "${BASE_IMAGE_FILE}" || printf 'unknown'
}

# Версия ядра, КОТОРОЙ ПРИНАДЛЕЖАТ СНИМАЕМЫЕ ДАННЫЕ. При обновлении образ уже
# несёт новую версию, а данные в томе — ещё от старой, поэтому entrypoint
# передаёт сюда прежнюю версию через SNAPSHOT_BASE_IMAGE. Именно её показывает
# `list` и на неё ориентируется откат.
data_base_image() {
  if [[ -n "${SNAPSHOT_BASE_IMAGE:-}" ]]; then printf '%s' "${SNAPSHOT_BASE_IMAGE}"; else image_base_image; fi
}

# Размер данных, которые реально попадут в снимок (в МБ, до сжатия).
payload_mb() {
  local total=0 dir
  for dir in "${HERMES_HOME}"/*; do
    [[ -e "${dir}" ]] || continue
    [[ "$(basename "${dir}")" == "backups" ]] && continue
    total=$(( total + $(du -sm "${dir}" 2>/dev/null | cut -f1 || echo 0) ))
  done
  printf '%s' "${total}"
}

# --- create ------------------------------------------------------------------
cmd_create() {
  local reason="${1:-manual}"
  [[ -d "${HERMES_HOME}" ]] || die "нет каталога данных ${HERMES_HOME}"

  local size_mb; size_mb="$(payload_mb)"
  if (( size_mb > MAX_MB )); then
    log "Данные весят ${size_mb} МБ > лимита STATE_BACKUP_MAX_MB=${MAX_MB} МБ — снимок пропущен."
    log "Поднимите лимит (STATE_BACKUP_MAX_MB) или снимайте выборочно: scripts/vault.sh backup."
    return 20   # особый код: снимка нет, но это осознанный лимит, а не сбой
  fi

  local id archive meta
  id="$(date -u +%Y%m%d-%H%M%S)-${reason//[^A-Za-z0-9._-]/_}"
  mkdir -p "${BACKUP_DIR}/${id}"
  archive="${BACKUP_DIR}/${id}/state.tar.gz"
  meta="${BACKUP_DIR}/${id}/meta.json"

  log "Снимаю состояние ${HERMES_HOME} (~${size_mb} МБ, причина: ${reason})…"
  # --numeric-owner: hermes работает под UID 10000, права должны пережить восстановление.
  if ! tar -czf "${archive}" --numeric-owner "${EXCLUDES[@]}" -C "${HERMES_HOME}" . 2>/dev/null; then
    rm -rf "${BACKUP_DIR}/${id}"
    die "не удалось создать архив (нет места на томе?)"
  fi

  cat > "${meta}" <<EOF
{
  "id": "${id}",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "${reason}",
  "base_image": "$(data_base_image)",
  "image_base_image": "$(image_base_image)",
  "hermes_home": "${HERMES_HOME}",
  "payload_mb": ${size_mb},
  "archive_bytes": $(stat -c %s "${archive}" 2>/dev/null || echo 0)
}
EOF
  log "Снимок готов: ${BACKUP_DIR}/${id} ($(du -sh "${archive}" | cut -f1))"
  cmd_prune "${KEEP}"
  printf '%s\n' "${id}"
}

# --- list --------------------------------------------------------------------
snapshot_ids() {
  [[ -d "${BACKUP_DIR}" ]] || return 0
  find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort
}

meta_field() {  # meta_field <id> <ключ>
  local f="${BACKUP_DIR}/$1/meta.json"
  [[ -f "${f}" ]] || { printf '?'; return 0; }
  sed -n "s/.*\"$2\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}.*/\1/p" "${f}" | head -n1
}

cmd_list() {
  local ids; ids="$(snapshot_ids)"
  if [[ -z "${ids}" ]]; then
    echo "Снимков пока нет (${BACKUP_DIR})."
    echo "Первый появится при смене версии ядра или по команде: state-snapshot.sh create"
    return 0
  fi
  # Блоками, а не таблицей: printf выравнивает по байтам, и кириллица в
  # заголовках колонок разъезжается.
  echo "Снимки состояния в ${BACKUP_DIR}:"
  local id
  while read -r id; do
    [[ -n "${id}" ]] || continue
    echo ""
    echo "${id}"
    echo "  создан : $(meta_field "${id}" created_at)"
    echo "  причина: $(meta_field "${id}" reason)"
    echo "  размер : $(du -sh "${BACKUP_DIR}/${id}/state.tar.gz" 2>/dev/null | cut -f1 || echo '?')"
    echo "  ядро   : $(meta_field "${id}" base_image)"
  done <<< "${ids}"
  echo ""
  echo "Откат данных: state-snapshot.sh restore <ID>   (или: restore last)"
}

resolve_id() {
  local want="$1"
  if [[ "${want}" == "last" ]]; then
    snapshot_ids | tail -n1
  else
    printf '%s' "${want}"
  fi
}

# --- verify ------------------------------------------------------------------
cmd_verify() {
  local id; id="$(resolve_id "${1:?usage: state-snapshot.sh verify <id|last>}")"
  local archive="${BACKUP_DIR}/${id}/state.tar.gz"
  [[ -f "${archive}" ]] || die "снимок ${id} не найден"
  tar -tzf "${archive}" >/dev/null || die "архив снимка ${id} повреждён"
  log "Снимок ${id} целый: $(tar -tzf "${archive}" | wc -l | tr -d ' ') записей."
}

# --- restore -----------------------------------------------------------------
cmd_restore() {
  local id assume_yes=false arg
  local -a rest=()
  for arg in "$@"; do
    [[ "${arg}" == "--yes" ]] && { assume_yes=true; continue; }
    rest+=("${arg}")
  done
  id="$(resolve_id "${rest[0]:?usage: state-snapshot.sh restore <id|last> [--yes]}")"

  local archive="${BACKUP_DIR}/${id}/state.tar.gz"
  [[ -f "${archive}" ]] || { cmd_list; die "снимок ${id} не найден"; }
  tar -tzf "${archive}" >/dev/null || die "архив снимка ${id} повреждён — восстановление отменено"

  echo "Восстановление состояния из снимка ${id}"
  echo "  создан : $(meta_field "${id}" created_at)"
  echo "  причина: $(meta_field "${id}" reason)"
  echo "  ядро   : $(meta_field "${id}" base_image)"
  echo ""
  echo "⚠ Останавливать бота перед восстановлением обязательно — иначе gbrain и"
  echo "  шлюз будут писать в том поверх восстанавливаемых файлов."
  echo "  локально: docker compose stop bot   |   amvera: остановить сервис."
  echo ""

  if [[ "${assume_yes}" != "true" ]]; then
    read -r -p "Восстановить состояние из ${id}? [y/N] " ans
    case "${ans}" in y|Y|yes|да|Да) ;; *) echo "Отменено."; exit 0 ;; esac
  fi

  # Страховка: текущее состояние тоже уходит в снимок — восстановление обратимо.
  log "Сначала снимаю текущее состояние (на случай, если откат окажется хуже)…"
  local pre_rc=0
  cmd_create "pre-restore" >/dev/null || pre_rc=$?
  case "${pre_rc}" in
    0)  ;;
    20) log "Текущее состояние не снято (упёрлось в STATE_BACKUP_MAX_MB) — откат будет односторонним." ;;
    *)  die "не удалось подстраховать текущее состояние — восстановление отменено" ;;
  esac

  log "Распаковываю ${id} в ${HERMES_HOME}…"
  # Распаковка поверх: файлы из снимка перезаписывают текущие, файлы, созданные
  # после снимка, остаются. Полная замена — сначала вручную очистить каталог.
  tar -xzf "${archive}" --numeric-owner -p -C "${HERMES_HOME}" \
    || die "распаковка не удалась — состояние могло остаться смешанным, повторите из ${BACKUP_DIR}"

  # Версия ядра в state.json — от снимка, чтобы следующий старт увидел смену
  # версии и снял свой снимок.
  mkdir -p "$(dirname "${STATE_FILE}")"
  cat > "${STATE_FILE}" <<EOF
{
  "base_image": "$(meta_field "${id}" base_image)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "restored_from": "${id}"
}
EOF

  log "Готово. Состояние соответствует снимку ${id}."
  log "Если откатывали неудачное обновление — верните и версию ядра:"
  log "  scripts/hermes-update.sh rollback  (в репозитории, затем передеплой)"
}

# --- prune -------------------------------------------------------------------
cmd_prune() {
  local keep="${1:-${KEEP}}" ids count
  ids="$(snapshot_ids)"; [[ -n "${ids}" ]] || return 0
  count="$(printf '%s\n' "${ids}" | wc -l | tr -d ' ')"
  (( count > keep )) || return 0
  local id
  while read -r id; do
    [[ -n "${id}" ]] || continue
    log "Удаляю старый снимок ${id} (храним последние ${keep})"
    rm -rf "${BACKUP_DIR:?}/${id}"
  done <<< "$(printf '%s\n' "${ids}" | head -n "$(( count - keep ))")"
}

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

cmd="${1:-list}"; shift || true
case "${cmd}" in
  create)  cmd_create "${1:-manual}" ;;
  list)    cmd_list ;;
  restore) cmd_restore "$@" ;;
  verify)  cmd_verify "${1:-last}" ;;
  prune)   cmd_prune "${1:-${KEEP}}" ;;
  -h|--help|help) usage ;;
  *)       usage; die "неизвестная команда: ${cmd}" ;;
esac
