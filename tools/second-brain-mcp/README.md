# second-brain-mcp

MCP-сервер (stdio), реализующий инструменты для слоёв 2, 4c, 4f, 6-9 конвейера
из [`../../ТЗ.md`](../../ТЗ.md) — персоны, запись в Obsidian-vault, исходы
решений, feedback и список моделей по цене. Владеет vault-ом на файловой
системе, не хранит состояние вне него (идемпотентен по перезапуску).

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
| `OPENROUTER_API_KEY` | — | Опционально, для каталога моделей (публичный каталог доступен и без ключа, но с ключом OpenRouter отдаёт персонализированные лимиты) |
| `SECOND_BRAIN_DIR` | корень репозитория | Откуда читать `config/layer_policy.json` и `config/fx.json` |
| `DATA_DIR` | родитель `VAULT_PATH` | Том для кэша бесплатного каталога (`free_models.json`) |
| `FREE_MODELS_CACHE` | `${DATA_DIR}/free_models.json` | Явный путь к кэшу каталога бесплатных моделей |

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
| `list_free_models` | 9 | `src/lib/models.js` + `src/lib/freeCatalog.js` |
| `recommend_model_for_layer` | 9 | `src/lib/models.js` + `src/lib/layerPolicy.js` |
| `estimate_model_cost` | 9 | `src/lib/cost.js` |
| `remember_handwriting` | 7 | `src/lib/handwriting.js` |
| `get_handwriting_profile` | 7 | `src/lib/handwriting.js` |

### Выбор модели (порт из GrowthProducer `src/llm/`)

- `openrouter.js` — общий кэшируемый каталог моделей OpenRouter (цены за 1M
  токенов, контекст, модальности, `isFree`).
- `freeCatalog.js` — «топ бесплатных»: авторитетный список — модели с нулевой
  ценой в каталоге OpenRouter, рейтинг shir-man top-models даёт порядок и
  суточные квоты. Дисковый кэш 24 ч, атомарная запись, fail-soft на
  протухший кэш.
- `layerPolicy.js` + `config/layer_policy.json` — критичность слоя →
  бесплатная/платная модель по умолчанию (плюс требования по модальностям).
- `cost.js` + `config/fx.json` — оценка вызова в USD/RUB и карточка цены.

Тот же каталог использует `docker/entrypoint.sh`: cheap-тир
`smart_model_routing` по умолчанию = топ-1 бесплатная модель
(`scripts/free-top1.mjs`, `FREE_MODELS_ENABLED`).

Формат frontmatter/vault — см. `ТЗ.md` §6. Этот сервер — единственный
писатель в vault (см. `Promts/08_obsidian_lint.md`, «Запреты»): агент не
должен трогать файловую систему vault-а в обход этих инструментов.

## Локальная проверка

```bash
cd tools/second-brain-mcp
bun install
VAULT_PATH=/tmp/vault-test bun test    # см. src/*.test.js
```
