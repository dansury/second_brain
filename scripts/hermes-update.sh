#!/usr/bin/env bash
# =============================================================================
# hermes-update.sh — авто-проверка и безопасное обновление ядра hermes-agent
# =============================================================================
# Базовый образ бота (nousresearch/hermes-agent) закреплён по digest в
# config/hermes/base-image.env. Этот скрипт — единственный способ этот пин
# двигать: он же пишет журнал и держит «предыдущую» версию для отката.
#
# Команды:
#   status              — что закреплено сейчас, что было раньше, что в апстриме
#   check               — есть ли новая версия в выбранном канале
#                         (код возврата: 0 — актуально, 10 — есть обновление)
#   update [--tag vX]   — закрепить новую версию (текущая уезжает в PREVIOUS)
#   rollback            — вернуть PREVIOUS (откат на одну версию назад)
#   pin <tag|digest>    — закрепить конкретную версию вручную
#   sync                — переписать строку FROM в Dockerfile из пин-файла
#   verify              — проверить, что Dockerfile и пин-файл не разошлись
#   history             — журнал всех перемещений пина
#
# Флаги: --quiet (только машинный вывод), --github-output (писать в
# $GITHUB_OUTPUT для workflow).
#
# ВАЖНО: скрипт меняет ТОЛЬКО версию ядра. Накопленные данные (мозг gbrain,
# vault, граф) он не трогает — их страхует scripts/state-snapshot.sh, который
# вызывается автоматически из docker/entrypoint.sh при смене версии.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="${HERMES_PIN_FILE:-${REPO_ROOT}/config/hermes/base-image.env}"
HISTORY_FILE="${REPO_ROOT}/config/hermes/base-image.history"
DOCKERFILE="${REPO_ROOT}/Dockerfile"

REGISTRY="https://registry-1.docker.io"
AUTH="https://auth.docker.io/token?service=registry.docker.io&scope=repository:%s:pull"
MANIFEST_ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

QUIET=false
GH_OUTPUT=false

log()  { [[ "${QUIET}" == "true" ]] || printf '[hermes-update] %s\n' "$*" >&2; }
die()  { printf '[hermes-update] ОШИБКА: %s\n' "$*" >&2; exit 1; }

# --- Пин-файл ----------------------------------------------------------------
load_pin() {
  [[ -f "${PIN_FILE}" ]] || die "не найден пин-файл ${PIN_FILE}"
  # shellcheck disable=SC1090
  set -a; source "${PIN_FILE}"; set +a
  : "${HERMES_IMAGE_REPO:?в пин-файле нет HERMES_IMAGE_REPO}"
  : "${HERMES_IMAGE_DIGEST:?в пин-файле нет HERMES_IMAGE_DIGEST}"
  HERMES_UPDATE_CHANNEL="${HERMES_UPDATE_CHANNEL:-release}"
  HERMES_IMAGE_TAG="${HERMES_IMAGE_TAG:-latest}"
  HERMES_PREVIOUS_TAG="${HERMES_PREVIOUS_TAG:-}"
  HERMES_PREVIOUS_DIGEST="${HERMES_PREVIOUS_DIGEST:-}"
}

# Точечная замена значения в пин-файле — комментарии и порядок строк сохраняются.
set_pin_value() {
  local key="$1" value="$2"
  grep -q "^${key}=" "${PIN_FILE}" \
    || die "в пин-файле нет ключа ${key} (файл повреждён?)"
  python3 - "${PIN_FILE}" "${key}" "${value}" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as fh:
    lines = fh.readlines()
for i, line in enumerate(lines):
    if line.startswith(key + "="):
        lines[i] = f"{key}={value}\n"
with open(path, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
PY
}

image_ref() {  # repo:tag@digest — сборка идёт по digest, тег для читаемости
  local tag="$1" digest="$2"
  if [[ -n "${tag}" && "${tag}" != "-" ]]; then
    printf '%s:%s@%s' "${HERMES_IMAGE_REPO}" "${tag}" "${digest}"
  else
    printf '%s@%s' "${HERMES_IMAGE_REPO}" "${digest}"
  fi
}

append_history() {
  local action="$1" from_ref="$2" to_ref="$3" note="${4:-}"
  mkdir -p "$(dirname "${HISTORY_FILE}")"
  [[ -f "${HISTORY_FILE}" ]] || cat > "${HISTORY_FILE}" <<'EOF'
# Журнал перемещений пина базового образа hermes-agent (append-only).
# Колонки (через табуляцию): UTC-время, действие, было, стало, примечание.
EOF
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${action}" "${from_ref}" "${to_ref}" "${note}" \
    >> "${HISTORY_FILE}"
}

# --- Docker Registry ---------------------------------------------------------
registry_token() {
  local url; url="$(printf "${AUTH}" "${HERMES_IMAGE_REPO}")"
  curl -fsS --max-time 30 "${url}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' \
    || die "не удалось получить токен Docker Hub (нет сети?)"
}

# Digest тега, каким его видит docker pull (docker-content-digest манифеста).
resolve_digest() {
  local tag="$1" token="$2" digest
  digest="$(curl -fsS --max-time 30 -o /dev/null -D - \
      -H "Authorization: Bearer ${token}" -H "Accept: ${MANIFEST_ACCEPT}" \
      "${REGISTRY}/v2/${HERMES_IMAGE_REPO}/manifests/${tag}" \
    | tr -d '\r' | sed -n 's/^docker-content-digest: //Ip' | tail -n1)"
  [[ -n "${digest}" ]] || die "не удалось определить digest тега ${tag}"
  printf '%s' "${digest}"
}

# Самый свежий релизный тег вида vГОД.МЕСЯЦ.ДЕНЬ[.N] — сортировка числовая
# по компонентам, а не лексикографическая (иначе v2026.8.9 > v2026.8.19).
PICK_LATEST_TAG_PY='
import json, re, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    sys.exit("Docker Hub вернул не JSON (нет доступа к hub.docker.com?)")
pat = re.compile(r"^v(\d+(?:\.\d+)*)$")
best = None
for item in data.get("results", []):
    m = pat.match(item.get("name", ""))
    if not m:
        continue
    key = tuple(int(p) for p in m.group(1).split("."))
    if best is None or key > best[0]:
        best = (key, item["name"])
if best is None:
    sys.exit("релизных тегов вида vX.Y.Z в репозитории образа не найдено")
print(best[1])
'

latest_release_tag() {
  local body tag
  body="$(curl -fsS --max-time 30 \
    "https://hub.docker.com/v2/repositories/${HERMES_IMAGE_REPO}/tags?page_size=100&ordering=last_updated")" \
    || die "не удалось получить список тегов с Docker Hub (нет сети?)"
  tag="$(printf '%s' "${body}" | python3 -c "${PICK_LATEST_TAG_PY}")" \
    || die "не удалось выбрать релизный тег"
  [[ -n "${tag}" ]] || die "пустой список релизных тегов"
  printf '%s' "${tag}"
}

# Целевая версия канала: (тег, digest)
resolve_target() {
  local tag token digest
  case "${HERMES_UPDATE_CHANNEL}" in
    release) tag="$(latest_release_tag)" || return 1 ;;
    latest)  tag="latest" ;;
    *)       die "неизвестный канал HERMES_UPDATE_CHANNEL=${HERMES_UPDATE_CHANNEL} (release|latest)" ;;
  esac
  token="$(registry_token)" || return 1
  digest="$(resolve_digest "${tag}" "${token}")" || return 1
  [[ -n "${digest}" ]] || return 1
  printf '%s %s' "${tag}" "${digest}"
}

# --- Dockerfile --------------------------------------------------------------
PIN_MARK_BEGIN='# >>> hermes-base-pin'
PIN_MARK_END='# <<< hermes-base-pin'

dockerfile_ref() {
  sed -n 's/^ARG HERMES_BASE_REF=//p' "${DOCKERFILE}" | head -n1
}

cmd_sync() {
  load_pin
  local want; want="$(image_ref "${HERMES_IMAGE_TAG}" "${HERMES_IMAGE_DIGEST}")"
  grep -q "^ARG HERMES_BASE_REF=" "${DOCKERFILE}" \
    || die "в Dockerfile нет строки 'ARG HERMES_BASE_REF=' (ожидается между маркерами ${PIN_MARK_BEGIN})"
  python3 - "${DOCKERFILE}" "${want}" <<'PY'
import sys
path, want = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    lines = fh.readlines()
for i, line in enumerate(lines):
    if line.startswith("ARG HERMES_BASE_REF="):
        lines[i] = f"ARG HERMES_BASE_REF={want}\n"
with open(path, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
PY
  log "Dockerfile синхронизирован: FROM ${want}"
}

cmd_verify() {
  load_pin
  local want have
  want="$(image_ref "${HERMES_IMAGE_TAG}" "${HERMES_IMAGE_DIGEST}")"
  have="$(dockerfile_ref)"
  if [[ "${want}" != "${have}" ]]; then
    printf 'Dockerfile и пин-файл разошлись:\n  пин-файл : %s\n  Dockerfile: %s\nПочините: scripts/hermes-update.sh sync\n' \
      "${want}" "${have}" >&2
    exit 1
  fi
  log "OK: Dockerfile собирается ровно из закреплённой версии ${want}"
}

# --- Команды -----------------------------------------------------------------
cmd_status() {
  load_pin
  printf 'Репозиторий образа : %s\n' "${HERMES_IMAGE_REPO}"
  printf 'Канал обновлений   : %s\n' "${HERMES_UPDATE_CHANNEL}"
  printf 'Закреплено сейчас  : %s\n' "$(image_ref "${HERMES_IMAGE_TAG}" "${HERMES_IMAGE_DIGEST}")"
  printf 'Закреплено с       : %s\n' "${HERMES_PINNED_AT:-неизвестно}"
  if [[ -n "${HERMES_PREVIOUS_DIGEST}" ]]; then
    printf 'Откат вернёт       : %s\n' "$(image_ref "${HERMES_PREVIOUS_TAG}" "${HERMES_PREVIOUS_DIGEST}")"
  else
    printf 'Откат вернёт       : (предыдущей версии нет)\n'
  fi
  printf 'Dockerfile         : %s\n' "$(dockerfile_ref)"
  local target
  if target="$(resolve_target 2>/dev/null)"; then
    local t_tag="${target%% *}" t_digest="${target##* }"
    printf 'В апстриме сейчас  : %s\n' "$(image_ref "${t_tag}" "${t_digest}")"
    [[ "${t_digest}" == "${HERMES_IMAGE_DIGEST}" ]] \
      && printf 'Итог               : версия актуальна\n' \
      || printf 'Итог               : ЕСТЬ ОБНОВЛЕНИЕ → scripts/hermes-update.sh update\n'
  else
    printf 'В апстриме сейчас  : (нет доступа к Docker Hub — проверка пропущена)\n'
  fi
}

# Код возврата: 0 — актуально, 10 — есть обновление.
cmd_check() {
  load_pin
  local target t_tag t_digest available=false
  target="$(resolve_target)"
  t_tag="${target%% *}"; t_digest="${target##* }"
  [[ "${t_digest}" != "${HERMES_IMAGE_DIGEST}" ]] && available=true

  if [[ "${GH_OUTPUT}" == "true" && -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "update_available=${available}"
      echo "current_tag=${HERMES_IMAGE_TAG}"
      echo "current_digest=${HERMES_IMAGE_DIGEST}"
      echo "target_tag=${t_tag}"
      echo "target_digest=${t_digest}"
      echo "target_ref=$(image_ref "${t_tag}" "${t_digest}")"
      echo "short_digest=${t_digest#sha256:}"
    } >> "${GITHUB_OUTPUT}"
  fi

  if [[ "${available}" == "true" ]]; then
    log "Есть обновление: ${HERMES_IMAGE_TAG} (${HERMES_IMAGE_DIGEST:0:19}…) → ${t_tag} (${t_digest:0:19}…)"
    [[ "${QUIET}" == "true" ]] && printf '%s %s\n' "${t_tag}" "${t_digest}"
    return 10
  fi
  log "Версия актуальна: ${HERMES_IMAGE_TAG} (${HERMES_IMAGE_DIGEST:0:19}…)"
  return 0
}

# Переставить пин на (тег, digest), текущий уводя в PREVIOUS.
apply_pin() {
  local new_tag="$1" new_digest="$2" action="${3:-update}" note="${4:-}"
  local old_ref new_ref
  old_ref="$(image_ref "${HERMES_IMAGE_TAG}" "${HERMES_IMAGE_DIGEST}")"
  new_ref="$(image_ref "${new_tag}" "${new_digest}")"

  if [[ "${new_digest}" == "${HERMES_IMAGE_DIGEST}" ]]; then
    log "Уже закреплено: ${new_ref} — менять нечего."
    return 0
  fi

  # Текущая версия становится целью отката — до перезаписи текущей.
  set_pin_value HERMES_PREVIOUS_TAG    "${HERMES_IMAGE_TAG}"
  set_pin_value HERMES_PREVIOUS_DIGEST "${HERMES_IMAGE_DIGEST}"
  set_pin_value HERMES_IMAGE_TAG       "${new_tag}"
  set_pin_value HERMES_IMAGE_DIGEST    "${new_digest}"
  set_pin_value HERMES_PINNED_AT       "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cmd_sync
  append_history "${action}" "${old_ref}" "${new_ref}" "${note}"
  log "${old_ref}"
  log "  → ${new_ref}"
  log "Дальше: закоммитить Dockerfile + config/hermes/ и задеплоить (amvera пересоберёт образ)."
}

cmd_update() {
  load_pin
  local new_tag="${1:-}" new_digest target
  if [[ -n "${new_tag}" ]]; then
    new_digest="$(resolve_digest "${new_tag}" "$(registry_token)")" \
      || die "тег ${new_tag} не найден в ${HERMES_IMAGE_REPO}"
  else
    target="$(resolve_target)"
    new_tag="${target%% *}"; new_digest="${target##* }"
  fi
  apply_pin "${new_tag}" "${new_digest}" "update" "канал=${HERMES_UPDATE_CHANNEL}"
}

cmd_pin() {
  load_pin
  local what="${1:?usage: hermes-update.sh pin <tag|sha256:...>}"
  local tag digest
  if [[ "${what}" == sha256:* ]]; then
    digest="${what}"; tag="-"
  else
    tag="${what}"
    digest="$(resolve_digest "${tag}" "$(registry_token)")" \
      || die "тег ${tag} не найден в ${HERMES_IMAGE_REPO}"
  fi
  apply_pin "${tag}" "${digest}" "pin" "вручную"
}

cmd_rollback() {
  load_pin
  [[ -n "${HERMES_PREVIOUS_DIGEST}" ]] \
    || die "предыдущая версия не записана — откатывать не на что (см. history)"
  local prev_tag="${HERMES_PREVIOUS_TAG}" prev_digest="${HERMES_PREVIOUS_DIGEST}"
  log "Откат на предыдущую версию: $(image_ref "${prev_tag}" "${prev_digest}")"
  # apply_pin сам положит текущую версию в PREVIOUS — так откат обратим
  # (повторный rollback вернёт ту версию, с которой откатились).
  apply_pin "${prev_tag}" "${prev_digest}" "rollback" "откат на предыдущую версию"
  log "Данные (мозг gbrain, vault, граф) откатываются отдельно:"
  log "  scripts/state-snapshot.sh list && scripts/state-snapshot.sh restore <id>"
}

cmd_history() {
  [[ -f "${HISTORY_FILE}" ]] || { echo "Журнал пуст: ${HISTORY_FILE} ещё не создан."; return 0; }
  if command -v column >/dev/null 2>&1; then
    grep -v '^#' "${HISTORY_FILE}" | column -t -s $'\t'
  else
    cat "${HISTORY_FILE}"
  fi
}

usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

main() {
  local cmd="" args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --quiet)         QUIET=true ;;
      --github-output) GH_OUTPUT=true ;;
      --tag)           args+=("${2:?--tag требует значение}"); shift ;;
      -h|--help)       usage; exit 0 ;;
      *)               [[ -z "${cmd}" ]] && cmd="$1" || args+=("$1") ;;
    esac
    shift
  done

  case "${cmd:-status}" in
    status)   cmd_status ;;
    check)    cmd_check ;;
    update)   cmd_update "${args[0]:-}" ;;
    pin)      cmd_pin "${args[0]:-}" ;;
    rollback) cmd_rollback ;;
    sync)     cmd_sync ;;
    verify)   cmd_verify ;;
    history)  cmd_history ;;
    *)        usage; die "неизвестная команда: ${cmd}" ;;
  esac
}

main "$@"
