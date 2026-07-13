#!/command/with-contenv bash
# =============================================================================
# second_brain — инициализация перед стартом Telegram-шлюза hermes
# =============================================================================
# Запускается s6-overlay как cont-init.d хук (от root, ДО старта сервисов).
# Задача: собрать $HERMES_HOME/config.yaml из переменных окружения —
#   • модель и провайдер LLM (OpenRouter);
#   • MCP-сервер gbrain (память) с эмбеддингами через Yandex Cloud;
#   • MCP-сервер Grafify (граф кода), если включён.
# Никаких секретов в образ не зашивается — всё берётся из окружения amvera.
# =============================================================================
set -euo pipefail

log() { printf '[second_brain] %s\n' "$*"; }

HERMES_HOME="${HERMES_HOME:-/opt/data}"
CONFIG="${HERMES_HOME}/config.yaml"
mkdir -p "${HERMES_HOME}"

# --- Обязательные переменные -------------------------------------------------
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN не задан — получите токен у @BotFather}"
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY не задан — ключ на https://openrouter.ai/keys}"

LLM_PROVIDER="${LLM_PROVIDER:-openrouter}"
LLM_MODEL="${LLM_MODEL:-anthropic/claude-opus-4.6}"

GBRAIN_ENABLED="${GBRAIN_ENABLED:-true}"
GBRAIN_HOME="${GBRAIN_HOME:-${HERMES_HOME}/gbrain}"
GBRAIN_EMBEDDING_PROVIDER="${GBRAIN_EMBEDDING_PROVIDER:-yandex}"

GRAFIFY_ENABLED="${GRAFIFY_ENABLED:-false}"
GRAFIFY_GRAPH_PATH="${GRAFIFY_GRAPH_PATH:-${HERMES_HOME}/graphify-out/graph.json}"
GRAFIFY_PYTHON="${GRAFIFY_PYTHON:-/opt/tools/gfx/bin/python}"

YANDEX_OPENAI_BASE_URL="${YANDEX_OPENAI_BASE_URL:-https://llm.api.cloud.yandex.net/v1}"
YANDEX_EMBEDDING_MODEL="${YANDEX_EMBEDDING_MODEL:-text-search-doc}"

# --- Опция: YandexGPT как основной LLM вместо OpenRouter ---------------------
# Hermes ходит в любой OpenAI-совместимый эндпоинт через model.base_url.
provider_block() {
  if [[ "${LLM_PROVIDER}" == "yandex" ]]; then
    : "${YANDEX_CLOUD_API_KEY:?YANDEX_CLOUD_API_KEY нужен при LLM_PROVIDER=yandex}"
    : "${YANDEX_CLOUD_FOLDER_ID:?YANDEX_CLOUD_FOLDER_ID нужен при LLM_PROVIDER=yandex}"
    local ygpt="${YANDEXGPT_MODEL:-yandexgpt/latest}"
    cat <<EOF
model:
  provider: openai-compatible
  default: "gpt://${YANDEX_CLOUD_FOLDER_ID}/${ygpt}"
  base_url: "${YANDEX_OPENAI_BASE_URL}"
  api_key_env: YANDEX_CLOUD_API_KEY
EOF
  else
    cat <<EOF
model:
  provider: openrouter
  default: "${LLM_MODEL}"
EOF
  fi
}

# --- MCP: gbrain (долговременная память) ------------------------------------
gbrain_block() {
  [[ "${GBRAIN_ENABLED}" == "true" ]] || return 0

  # Эмбеддинги. По умолчанию — Yandex Cloud через OpenAI-совместимый эндпоинт.
  local emb_env=""
  case "${GBRAIN_EMBEDDING_PROVIDER}" in
    yandex)
      : "${YANDEX_CLOUD_API_KEY:?YANDEX_CLOUD_API_KEY нужен для эмбеддингов gbrain}"
      : "${YANDEX_CLOUD_FOLDER_ID:?YANDEX_CLOUD_FOLDER_ID нужен для эмбеддингов gbrain}"
      emb_env=$(cat <<EOF
      OPENAI_BASE_URL: "${YANDEX_OPENAI_BASE_URL}"
      OPENAI_API_KEY: "${YANDEX_CLOUD_API_KEY}"
      EMBEDDING_MODEL: "openai:emb://${YANDEX_CLOUD_FOLDER_ID}/${YANDEX_EMBEDDING_MODEL}/latest"
EOF
)
      ;;
    zeroentropy)
      emb_env=$(cat <<EOF
      ZEROENTROPY_API_KEY: "${ZEROENTROPY_API_KEY:-}"
EOF
)
      ;;
    openai|*)
      emb_env=$(cat <<EOF
      OPENAI_BASE_URL: "${OPENAI_BASE_URL:-https://api.openai.com/v1}"
      OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
EOF
)
      ;;
  esac

  cat <<EOF
  gbrain:
    command: gbrain
    args: [serve]
    enabled: true
    timeout: 120
    env:
      GBRAIN_HOME: "${GBRAIN_HOME}"
      HOME: "${HERMES_HOME}"
${emb_env}
EOF
}

# --- MCP: Grafify (граф кода) -----------------------------------------------
grafify_block() {
  [[ "${GRAFIFY_ENABLED}" == "true" ]] || return 0
  if [[ ! -f "${GRAFIFY_GRAPH_PATH}" ]]; then
    log "GRAFIFY_ENABLED=true, но граф ${GRAFIFY_GRAPH_PATH} не найден — MCP Grafify пропущен."
    log "Постройте граф: make graph (или scripts/build-graph.sh), затем перезапустите."
    return 0
  fi
  local gpy="python"
  [[ -x "${GRAFIFY_PYTHON}" ]] && gpy="${GRAFIFY_PYTHON}"
  cat <<EOF
  grafify:
    command: "${gpy}"
    args: ["-m", "graphify.serve", "${GRAFIFY_GRAPH_PATH}"]
    enabled: true
    timeout: 120
EOF
}

# --- Сборка config.yaml ------------------------------------------------------
log "Пишу ${CONFIG} (провайдер=${LLM_PROVIDER}, модель=${LLM_MODEL})"
mcp_out="$(gbrain_block; grafify_block)"
{
  provider_block
  if [[ -n "${mcp_out//[$'\n\t ']/}" ]]; then
    echo ""
    echo "mcp_servers:"
    printf '%s\n' "${mcp_out}"
  fi
} > "${CONFIG}"

# --- Инициализация мозга gbrain (один раз) ----------------------------------
if [[ "${GBRAIN_ENABLED}" == "true" ]]; then
  mkdir -p "${GBRAIN_HOME}"
  if command -v gbrain >/dev/null 2>&1; then
    if [[ ! -f "${GBRAIN_HOME}/config.json" && ! -d "${GBRAIN_HOME}/.gbrain" ]]; then
      log "Инициализирую gbrain в ${GBRAIN_HOME} (PGLite, без внешней БД)"
      HOME="${HERMES_HOME}" GBRAIN_HOME="${GBRAIN_HOME}" gbrain init --yes 2>&1 | sed 's/^/[gbrain] /' || \
        log "gbrain init завершился с ошибкой — память подключится при первом обращении."
    fi
  else
    log "Бинарь gbrain не найден в образе — проверьте сборку Dockerfile."
  fi
fi

log "Готово. s6 запустит: hermes gateway run"
