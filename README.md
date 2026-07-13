# second_brain

Telegram-бот — личный «второй мозг» на связке трёх проектов, разворачиваемый
на **amvera.ru**. LLM-мозг работает через **OpenRouter**, долговременная память —
через **Yandex Cloud** (эмбеддинги).

## Что внутри

| Компонент | Роль | Как подключён |
|---|---|---|
| [**hermes-agent**](https://github.com/NousResearch/hermes-agent) | Ядро агента и Telegram-шлюз. LLM через OpenRouter. | Базовый образ `nousresearch/hermes-agent`, запуск `gateway run` |
| [**gbrain**](https://github.com/garrytan/gbrain) | Долговременная память (семантический поиск по заметкам/фактам). | MCP-сервер `gbrain serve`; эмбеддинги — Yandex Cloud |
| [**Grafify**](https://github.com/LuaAccess/Grafify) | Граф знаний по коду (опционально). | MCP-сервер `graphify.serve` (включается флагом) |

```
Telegram ──> hermes-agent (Telegram gateway)
                  │  LLM  ──────────────> OpenRouter API
                  │  MCP  ──> gbrain ───> Yandex Cloud API (эмбеддинги)
                  └─ MCP  ──> Grafify (граф кода, опц.)
        Всё в одном контейнере на amvera.ru, данные — в томе /opt/data
```

### Как используются обе API

- **OpenRouter** — «мозг»: все ответы и рассуждения агента (`OPENROUTER_API_KEY`,
  модель в `LLM_MODEL`).
- **Yandex Cloud** — память: эмбеддинги gbrain через OpenAI-совместимый эндпоинт
  `https://llm.api.cloud.yandex.net/v1` (`YANDEX_CLOUD_API_KEY` + `YANDEX_CLOUD_FOLDER_ID`).
  YandexGPT можно включить и как основной LLM вместо OpenRouter — см. блок 6 в `env.example`.

## Быстрый старт (локально)

```bash
cp env.example .env          # заполните TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY,
                             # YANDEX_CLOUD_API_KEY, YANDEX_CLOUD_FOLDER_ID
docker compose up --build    # бот поднимется в режиме long polling
```

Напишите боту в Telegram. Свой Telegram ID узнайте у [@userinfobot](https://t.me/userinfobot)
и впишите в `TELEGRAM_ALLOWED_USERS`.

## Деплой на amvera.ru

1. Запушьте репозиторий в amvera (git push в проект amvera) — сборка идёт из
   `Dockerfile`, конфиг деплоя — `amvera.yml` (том монтируется в `/opt/data`).
2. В интерфейсе сервиса → **«Переменные»** задайте секреты (НЕ коммитьте их):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_USERS`
   - `OPENROUTER_API_KEY`, `LLM_MODEL`
   - `YANDEX_CLOUD_API_KEY`, `YANDEX_CLOUD_FOLDER_ID`
3. Пересоберите/перезапустите сервис. Бот работает в режиме long polling —
   публичный порт не требуется.

### Ключи: где взять
- **Telegram** — [@BotFather](https://t.me/BotFather)
- **OpenRouter** — https://openrouter.ai/keys
- **Yandex Cloud** — сервисный аккаунт с ролью `ai.languageModels.user`, затем
  API-ключ и `folder_id`: https://yandex.cloud/ru/docs/ai-studio/

## Память (gbrain)

`gbrain` инициализируется автоматически при первом старте в `GBRAIN_HOME`
(`/opt/data/gbrain`, PGLite — внешняя БД не нужна) и переживает перезапуски
благодаря постоянному тому amvera. Эмбеддинги по умолчанию считаются в Yandex
Cloud (`GBRAIN_EMBEDDING_PROVIDER=yandex`). Альтернативы — `openai`, `zeroentropy`.

## Граф кода (Grafify, опционально)

```bash
make graph            # построит graphify-out/graph.json по этому репозиторию
# затем: GRAFIFY_ENABLED=true и GRAFIFY_GRAPH_PATH=/opt/data/graphify-out/graph.json
```

Grafify анализирует код локально (tree-sitter, без вызовов API) и отдаёт граф
агенту как MCP-инструмент — удобно для вопросов «что с чем связано в коде».

## Файлы репозитория

| Файл | Назначение |
|---|---|
| `Dockerfile` | Единый образ: hermes + bun/gbrain + graphify |
| `amvera.yml` | Конфиг деплоя amvera (том → `/opt/data`) |
| `docker/entrypoint.sh` | Собирает `config.yaml` hermes из переменных окружения на старте |
| `docker-compose.yml` | Локальный запуск (тот же образ) |
| `env.example` | Все переменные с комментариями |
| `config/hermes/config.example.yaml` | Как выглядит итоговый конфиг hermes |
| `scripts/build-graph.sh`, `Makefile` | Утилиты (граф Grafify и пр.) |

## Проверка перед продом

Проект — деплой-каркас: ключи, сборка образа и запуск на amvera выполняются на
вашей стороне. Рекомендуется сначала прогнать `docker compose up --build`
локально с реальными ключами, убедиться, что бот отвечает в Telegram и что в
логах поднялись MCP-серверы `gbrain` (и `grafify`, если включён), — и только
потом деплоить на amvera.
