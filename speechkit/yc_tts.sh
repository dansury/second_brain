#!/usr/bin/env bash
# =============================================================================
# yc_tts.sh — синтез речи Yandex SpeechKit как command-TTS-провайдер hermes
# =============================================================================
# hermes вызывает command-провайдер с плейсхолдерами:
#   $1 = {input_path}   — путь к файлу с текстом для озвучки
#   $2 = {output_path}  — куда записать аудио
#   $3 = {format}       — желаемый формат (ogg/opus/mp3/wav)
#   $4 = {voice}        — голос (по умолчанию alena)
#
# Использует REST SpeechKit v1 synthesize. Для голосовых «пузырей» Telegram
# нужен OggOpus — это формат по умолчанию.
# Документация: https://yandex.cloud/ru/docs/speechkit/tts/request
# =============================================================================
set -euo pipefail

IN="${1:?input_path не передан}"
OUT="${2:?output_path не передан}"
REQ_FMT="${3:-}"
VOICE="${4:-${YANDEX_TTS_VOICE:-alena}}"
[ -n "${VOICE}" ] || VOICE="alena"

: "${YANDEX_CLOUD_API_KEY:?YANDEX_CLOUD_API_KEY не задан}"
: "${YANDEX_CLOUD_FOLDER_ID:?YANDEX_CLOUD_FOLDER_ID не задан}"

# Приводим формат hermes к формату SpeechKit.
case "${REQ_FMT,,}" in
  ""|ogg|opus|oggopus) YFMT=oggopus ;;
  mp3)                  YFMT=mp3 ;;
  wav|lpcm|pcm)         YFMT=lpcm ;;
  *)                    YFMT=oggopus ;;
esac

TEXT="$(cat "${IN}")"

curl -sS --fail-with-body -X POST \
  -H "Authorization: Api-Key ${YANDEX_CLOUD_API_KEY}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "lang=${YANDEX_TTS_LANG:-ru-RU}" \
  --data-urlencode "voice=${VOICE}" \
  --data-urlencode "format=${YFMT}" \
  --data-urlencode "folderId=${YANDEX_CLOUD_FOLDER_ID}" \
  "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize" \
  --output "${OUT}" || {
    echo "SpeechKit TTS: запрос не удался (voice=${VOICE}, format=${YFMT})" >&2
    exit 1
  }
