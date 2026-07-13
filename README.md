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
                  │  LLM   ─────────────> OpenRouter API  (агент + суммаризатор)
                  │  voice ─> SpeechKit ─> Yandex Cloud API (STT + TTS)
                  │  MCP   ─> gbrain ────> Yandex Cloud API (эмбеддинги памяти)
                  └─ MCP   ─> Grafify (граф кода, опц.)
        Выбор модели/провайдера агента — команда /model в Telegram.
        Всё в одном контейнере на amvera.ru, данные — в томе /opt/data
```

### Как используются обе API

- **OpenRouter** — «мозг»: ответы и рассуждения агента (`OPENROUTER_API_KEY`,
  модель в `LLM_MODEL`), а также вторичная роль — суммаризатор авто-сжатия
  диалога (`LLM_SUMMARY_MODEL`).
- **Yandex Cloud** — используется двояко:
  - **Голос (основной)** — Yandex SpeechKit как STT (распознавание) и TTS
    (синтез) голосовых Telegram, подключён как command-провайдеры hermes
    (`speechkit/yc_stt.sh`, `speechkit/yc_tts.sh`).
  - **Память** — эмбеддинги gbrain через OpenAI-совместимый эндпоинт
    `https://llm.api.cloud.yandex.net/v1`.
  - Всё на одних ключах `YANDEX_CLOUD_API_KEY` + `YANDEX_CLOUD_FOLDER_ID`.
  - YandexGPT можно включить и как основной LLM вместо OpenRouter (`LLM_PROVIDER=yandex`).

### Выбор провайдера и модели: команда `/model`

Для основного агента провайдер и модель переключаются прямо в Telegram —
командой `/model` (встроена в hermes). Открывает интерактивный список моделей
текущего провайдера (полный каталог OpenRouter):

```
/model                                  открыть пикер / список моделей
/model anthropic/claude-opus-4.6        переключить модель
/model --provider openrouter            сменить провайдера (openrouter | yandex ...)
/model gpt://<folder>/yandexgpt/latest --provider yandex
```

«Каждый процесс, которому нужен LLM», настраивается отдельно:

| Процесс | Как выбрать модель/провайдера |
|---|---|
| Основной агент | `/model` в Telegram (интерактивно) или `LLM_MODEL` / `LLM_PROVIDER` |
| Суммаризатор авто-сжатия | `LLM_SUMMARY_MODEL` / `LLM_SUMMARY_PROVIDER` (env → `auxiliary.compression`) |
| Эмбеддинги памяти (gbrain) | `GBRAIN_EMBEDDING_PROVIDER` + `YANDEX_EMBEDDING_MODEL` |
| Голос STT/TTS | Yandex SpeechKit (`YANDEX_STT_LANG`, `YANDEX_TTS_VOICE`) |

### Голос (Yandex SpeechKit)

Голосовые сообщения Telegram распознаются SpeechKit-ом, а ответы могут
озвучиваться обратно (`VOICE_AUTO_TTS=true`). Реализовано без форка hermes —
через штатный механизм command-провайдеров STT/TTS. Голос и язык:
`YANDEX_TTS_VOICE` (alena, filipp, jane…), `YANDEX_STT_LANG` (ru-RU).

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

## Граф кода (Grafify, опционально) — как именно используется

Grafify — это **инструмент агента**, а не часть чата или памяти. Работает так:

1. **Построение графа.** Grafify локально (tree-sitter, без вызовов API)
   разбирает код репозитория и строит `graphify-out/graph.json` — граф связей
   между функциями, модулями, классами.
2. **Подключение как MCP-сервер.** При `GRAFIFY_ENABLED=true` hermes запускает
   `python -m graphify.serve <graph.json>` и получает MCP-инструменты запроса графа.
3. **Использование в диалоге.** Агент вызывает эти инструменты, когда вы
   спрашиваете о структуре кода: «что вызывает функцию X?», «что сломается, если
   поменять модуль Y?», «как auth связан с базой?». Он обходит граф вместо grep.

```bash
make graph            # построит graphify-out/graph.json по этому репозиторию
# затем задайте: GRAFIFY_ENABLED=true и
#                GRAFIFY_GRAPH_PATH=/opt/data/graphify-out/graph.json
```

По умолчанию выключен: без готового графа MCP-сервер не поднимается (агент при
этом остаётся полноценным Telegram-ботом с памятью и голосом).

## Файлы репозитория

| Файл | Назначение |
|---|---|
| `Dockerfile` | Единый образ: hermes + bun/gbrain + graphify |
| `amvera.yml` | Конфиг деплоя amvera (том → `/opt/data`) |
| `docker/entrypoint.sh` | Собирает `config.yaml` hermes из переменных окружения на старте |
| `docker-compose.yml` | Локальный запуск (тот же образ) |
| `speechkit/yc_stt.sh`, `yc_tts.sh` | Yandex SpeechKit как STT/TTS (command-провайдеры hermes) |
| `env.example` | Все переменные с комментариями |
| `config/hermes/config.example.yaml` | Как выглядит итоговый конфиг hermes |
| `.github/workflows/build.yml` | CI: фактическая сборка образа на пуш/PR |
| `scripts/build-graph.sh`, `Makefile` | Утилиты (граф Grafify и пр.) |

## Сборка образа

Образ собирается из `Dockerfile` (база — `nousresearch/hermes-agent:latest` +
bun/gbrain + graphify + скрипты SpeechKit). Сборку выполняет:

- **CI** — `.github/workflows/build.yml` собирает образ на раннерах GitHub при
  каждом пуше/PR (у них есть доступ к Docker Hub). Это фактический прогон сборки —
  смотрите статус в PR.
- **amvera** — собирает тот же `Dockerfile` при деплое.
- **локально** — `docker compose up --build`.

## Проверка перед продом

Проект — деплой-каркас: ключи, сборка образа и запуск на amvera выполняются на
вашей стороне (в песочнице разработки прямой доступ к Docker Hub закрыт egress-
политикой, поэтому образ собирается в CI/на amvera, а не здесь). Рекомендуется:

1. Прогнать `docker compose up --build` локально с реальными ключами.
2. Убедиться, что бот отвечает в Telegram (текст и голос) и что в логах
   поднялись MCP-серверы `gbrain` (и `grafify`, если включён).
3. Затем деплоить на amvera.

Что уже проверено в этом репозитории: синтаксис shell-скриптов (`bash -n`),
рендеринг итогового `config.yaml` во всех режимах (валидный YAML), логика
разбора ответа SpeechKit STT и маппинга форматов TTS.
