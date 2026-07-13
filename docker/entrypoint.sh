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

# Логи идут в stderr, чтобы не попадать в config.yaml, который собирается
# через подстановку команд (stdout захватывается).
log() { printf '[second_brain] %s\n' "$*" >&2; }

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

# Grafify включён по умолчанию: в образ зашит граф этого репозитория
# (/opt/second_brain/graphify-out/graph.json). Свой граф пользователь может
# положить в /opt/data/graphify-out/graph.json и указать через GRAFIFY_GRAPH_PATH.
GRAFIFY_ENABLED="${GRAFIFY_ENABLED:-true}"
GRAFIFY_GRAPH_PATH="${GRAFIFY_GRAPH_PATH:-/opt/second_brain/graphify-out/graph.json}"
GRAFIFY_PYTHON="${GRAFIFY_PYTHON:-/opt/tools/gfx/bin/python}"

# secondbrain: MCP-сервер дневника-консультанта (см. ТЗ.md §9).
SECONDBRAIN_ENABLED="${SECONDBRAIN_ENABLED:-true}"
SECONDBRAIN_DIR="${SECONDBRAIN_DIR:-/opt/second_brain/secondbrain}"
OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH:-${HERMES_HOME}/vault}"

YANDEX_OPENAI_BASE_URL="${YANDEX_OPENAI_BASE_URL:-https://llm.api.cloud.yandex.net/v1}"
YANDEX_EMBEDDING_MODEL="${YANDEX_EMBEDDING_MODEL:-text-search-doc}"

# Голос: Yandex SpeechKit — основной движок STT/TTS (command-провайдеры hermes).
VOICE_ENABLED="${VOICE_ENABLED:-true}"
SPEECHKIT_DIR="${SPEECHKIT_DIR:-/opt/second_brain/speechkit}"

# --- Реестр провайдеров: делает Yandex выбираемым в /model -------------------
# Кастомный OpenAI-совместимый провайдер «yandex» появляется в пикере /model
# и в `/model --provider yandex`. Ключ берётся из YANDEX_CLOUD_API_KEY.
providers_block() {
  [[ -n "${YANDEX_CLOUD_FOLDER_ID:-}" ]] || return 0
  local f="${YANDEX_CLOUD_FOLDER_ID}"
  cat <<EOF

# Провайдеры для команды /model (кроме встроенного openrouter).
providers:
  yandex:
    name: "Yandex Cloud (YandexGPT)"
    base_url: "${YANDEX_OPENAI_BASE_URL}"
    key_env: YANDEX_CLOUD_API_KEY
    default_model: "gpt://${f}/yandexgpt/latest"
    discover_models: false
    models:
      - "gpt://${f}/yandexgpt/latest"
      - "gpt://${f}/yandexgpt-lite/latest"
EOF
}

# --- Основной LLM: OpenRouter (по умолчанию) или Yandex ----------------------
provider_block() {
  if [[ "${LLM_PROVIDER}" == "yandex" ]]; then
    : "${YANDEX_CLOUD_API_KEY:?YANDEX_CLOUD_API_KEY нужен при LLM_PROVIDER=yandex}"
    : "${YANDEX_CLOUD_FOLDER_ID:?YANDEX_CLOUD_FOLDER_ID нужен при LLM_PROVIDER=yandex}"
    local ygpt="${YANDEXGPT_MODEL:-yandexgpt/latest}"
    cat <<EOF
model:
  provider: yandex
  default: "gpt://${YANDEX_CLOUD_FOLDER_ID}/${ygpt}"
EOF
  else
    cat <<EOF
model:
  provider: openrouter
  default: "${LLM_MODEL}"
EOF
  fi
}

# --- Голос: Yandex SpeechKit как основной STT/TTS ---------------------------
voice_block() {
  [[ "${VOICE_ENABLED}" == "true" ]] || return 0
  : "${YANDEX_CLOUD_API_KEY:?YANDEX_CLOUD_API_KEY нужен для голоса (SpeechKit)}"
  : "${YANDEX_CLOUD_FOLDER_ID:?YANDEX_CLOUD_FOLDER_ID нужен для голоса (SpeechKit)}"
  local stt_lang="${YANDEX_STT_LANG:-ru-RU}"
  local tts_voice="${YANDEX_TTS_VOICE:-alena}"
  local auto_tts="${VOICE_AUTO_TTS:-true}"
  cat <<EOF

# Распознавание речи: Yandex SpeechKit (command-провайдер)
stt:
  provider: yandex
  providers:
    yandex:
      type: command
      language: "${stt_lang}"
      command: "${SPEECHKIT_DIR}/yc_stt.sh {input_path} {output_path} {language}"

# Синтез речи: Yandex SpeechKit (command-провайдер)
voice:
  auto_tts: ${auto_tts}
tts:
  provider: yandex
  providers:
    yandex:
      type: command
      voice: "${tts_voice}"
      command: "${SPEECHKIT_DIR}/yc_tts.sh {input_path} {output_path} {format} {voice}"
EOF
}

# --- Вторичная LLM-роль: суммаризатор сжатия контекста -----------------------
# «Каждый процесс, которому нужен LLM»: помимо основного агента (см. /model),
# отдельная модель используется для авто-сжатия длинного диалога.
auxiliary_block() {
  [[ -n "${LLM_SUMMARY_MODEL:-}" ]] || return 0
  cat <<EOF

auxiliary:
  compression:
    summary_provider: ${LLM_SUMMARY_PROVIDER:-openrouter}
    summary_model: "${LLM_SUMMARY_MODEL}"
EOF
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

# --- MCP: secondbrain (дневник-консультант, ТЗ.md §9) ------------------------
secondbrain_block() {
  [[ "${SECONDBRAIN_ENABLED}" == "true" ]] || return 0
  cat <<EOF
  secondbrain:
    command: node
    args: ["${SECONDBRAIN_DIR}/src/cli.mjs", "serve"]
    enabled: true
    timeout: 60
    env:
      OBSIDIAN_VAULT_PATH: "${OBSIDIAN_VAULT_PATH}"
EOF
}

# --- Сборка config.yaml ------------------------------------------------------
log "Пишу ${CONFIG} (провайдер=${LLM_PROVIDER}, модель=${LLM_MODEL})"
mcp_out="$(gbrain_block; grafify_block; secondbrain_block)"
{
  provider_block
  providers_block
  voice_block
  auxiliary_block
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

# --- Инициализация хранилища secondbrain (идемпотентно) ---------------------
if [[ "${SECONDBRAIN_ENABLED}" == "true" ]]; then
  if command -v node >/dev/null 2>&1; then
    log "Инициализирую Obsidian-хранилище secondbrain в ${OBSIDIAN_VAULT_PATH}"
    OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH}" node "${SECONDBRAIN_DIR}/src/cli.mjs" init 2>&1 | sed 's/^/[secondbrain] /' || \
      log "secondbrain init завершился с ошибкой — хранилище создастся при первом обращении."
  else
    log "node не найден в образе — secondbrain MCP пропущен (проверьте сборку Dockerfile)."
  fi
fi

log "Готово. s6 запустит: hermes gateway run"
