#!/usr/bin/env bash
# =============================================================================
# yc_stt.sh — распознавание речи Yandex SpeechKit как command-STT-провайдер hermes
# =============================================================================
# hermes вызывает command-провайдер с плейсхолдерами:
#   $1 = {input_path}   — путь к аудио (голосовое Telegram = OggOpus)
#   $2 = {output_path}  — куда записать текст расшифровки
#   $3 = {language}     — код языка (по умолчанию ru-RU)
#
# Использует синхронный REST SpeechKet v1 (короткое аудио ≤30 c, ≤1 МБ —
# ровно формат голосовых Telegram). Ключи берутся из окружения контейнера.
# Документация: https://yandex.cloud/ru/docs/speechkit/stt/api/request-analysis
# =============================================================================
set -euo pipefail

IN="${1:?input_path не передан}"
OUT="${2:?output_path не передан}"
LANG_CODE="${3:-${YANDEX_STT_LANG:-ru-RU}}"
[ -n "${LANG_CODE}" ] || LANG_CODE="ru-RU"

: "${YANDEX_CLOUD_API_KEY:?YANDEX_CLOUD_API_KEY не задан}"
: "${YANDEX_CLOUD_FOLDER_ID:?YANDEX_CLOUD_FOLDER_ID не задан}"

# Формат распознавания. Голосовые Telegram — OggOpus. Можно переопределить
# YANDEX_STT_FORMAT (oggopus|lpcm) для иных источников.
FMT="${YANDEX_STT_FORMAT:-oggopus}"

resp="$(curl -sS --fail-with-body -X POST \
  -H "Authorization: Api-Key ${YANDEX_CLOUD_API_KEY}" \
  --data-binary @"${IN}" \
  "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=${YANDEX_CLOUD_FOLDER_ID}&lang=${LANG_CODE}&format=${FMT}")" || {
    echo "SpeechKit STT: запрос не удался: ${resp:-нет ответа}" >&2
    exit 1
  }

# Ответ вида {"result":"распознанный текст"}
printf '%s' "${resp}" | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("result",""), end="")
except Exception as e:
    sys.stderr.write("SpeechKit STT: не разобрал ответ: %s\n" % e); sys.exit(1)' > "${OUT}"
