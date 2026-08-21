# second-brain-mcp

MCP-сервер (stdio), реализующий инструменты для слоёв 2, 4c, 4f, 6-10 конвейера
из [`../../ТЗ.md`](../../ТЗ.md) — персоны, запись в Obsidian-vault, исходы
решений, feedback, список моделей по цене и импорт всей истории канала/группы.
Владеет vault-ом на файловой системе, не хранит состояние вне него
(идемпотентен по перезапуску).

Реализует M1 (дорожная карта ТЗ §12, 8 инструментов) и M2 (`set_decision_outcome`
для слоя 4f + фильтр `status` в `search_vault` для прецедентов 4c).
Vision-зависимые слои (6, 7) используют собственный анализ модели через
image input; этот сервер даёт им только память дизамбигуации и профили
почерков, сам анализ изображения не делает.

## Запуск

```bash
VAULT_PATH=/opt/data/vault bun run src/index.js
```

В образе second_brain запускается как ещё один MCP-сервер hermes-agent
(`mcp_servers.second-brain` в `config.yaml`, см. `docker/entrypoint.sh`).

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `VAULT_PATH` | `/opt/data/vault` | Корень Obsidian-vault-а |
| `OPENROUTER_API_KEY` | — | Опционально, для `list_models_by_price` (публичный каталог моделей доступен и без ключа, но с ключом OpenRouter отдаёт персонализированные лимиты) |

## Инструменты

| Tool | Слой | Файл |
|---|---|---|
| `lookup_character` | 2 | `src/lib/characters.js` |
| `upsert_character` | 2, 8 | `src/lib/characters.js` |
| `obsidian_write_entry` | 8 | `src/lib/entries.js` |
| `search_vault` | 4c, 4f | `src/lib/entries.js` |
| `set_decision_outcome` | 4f | `src/lib/decisions.js` |
| `record_feedback` | 9 | `src/lib/feedback.js` |
| `list_models_by_price` | 9 | `src/lib/models.js` |
| `remember_handwriting` | 7 | `src/lib/handwriting.js` |
| `get_handwriting_profile` | 7 | `src/lib/handwriting.js` |
| `import_chat_history` | 10 | `src/lib/history.js` |
| `import_chat_history_file` | 10 | `src/lib/history.js` |
| `history_import_status` | 10 | `src/lib/history.js` |

### Импорт истории канала/группы (слой 10)

Telegram Bot API не отдаёт историю чата — бот видит только апдейты после
подключения. Поэтому история берётся так же, как в GrowthProducer
(`src/channels/history_import.py`):

- `import_chat_history({ chat, limit: 0, since_id: 0, dry_run: false })` —
  публичное веб-превью `https://t.me/s/<username>` с пагинацией `?before=<id>`;
  `limit: 0` — вся доступная история, `since_id` — догрузка только новее.
- `import_chat_history_file({ file, chat? })` — JSON-выгрузка Telegram Desktop
  (Настройки → Экспорт данных → JSON) для приватных каналов, групп и
  «Избранного», у которых превью нет.
- `history_import_status({ chat? })` — сколько импортировано, диапазон id,
  время последнего прогона (отсюда `since_id` для догрузки).

Записи ложатся в `Journal/<год>/<месяц>/<дата>.md` датой и временем
оригинального сообщения, с frontmatter `source: telegram-history`,
`via: tme-preview|tg-export`, `tg_chat` и постоянной ссылкой на оригинал в теле.
Идемпотентность двойная: id в `<vault>/.state/history-import.json` **и** проверка
ссылки в файле дня — потеря состояния не приводит к дублям. Импорт
детерминирован (парсинг, без LLM); в ответе — поле `recent` (≤20 свежих
записей), которое агент прогоняет через слои 2–4, см. `Promts/10_history_import.md`.

Сетевой доступ нужен только `import_chat_history` (GET на `t.me`); остальные
инструменты работают офлайн по файловой системе.

Формат frontmatter/vault — см. `ТЗ.md` §6. Этот сервер — единственный
писатель в vault (см. `Promts/08_obsidian_lint.md`, «Запреты»): агент не
должен трогать файловую систему vault-а в обход этих инструментов.

## Локальная проверка

```bash
cd tools/second-brain-mcp
bun install
VAULT_PATH=/tmp/vault-test bun test    # см. src/*.test.js
```
