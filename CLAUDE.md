# CLAUDE.md — second_brain

## Порядок работы

**#1 Сначала `TODO.md` и `DEV_PLAN.md`.** `TODO.md` — только незакрытые
задачи; `DEV_PLAN.md` — порядок фаз, зависимости и реестр блокеров.
`[BLOCKED: причина]` означает «пропусти и иди дальше», маркер не снимать,
пока причина не снята по-настоящему.

**#2 Один документ на задачу.** Источники правды: `ТЗ.md` (технический слой:
конвейер 0–9, vault, MCP-инструменты), `PRD.md` (продукт: сценарии,
требования, метрики), `Promts/<слой>.md` (поведение конкретного слоя),
`README.md` (стек и эксплуатация). Открывать ОДИН документ по задаче; не
хватает детали — читать исходник, а не второй документ «на всякий случай».

**#3 Doc-driven.** Меняется дизайн — сначала правится документ (`ТЗ.md`,
`PRD.md`, `Promts/*`), отдельным коммитом, потом пишется код. Чистый багфикс
без дизайн-решений может пропустить этот шаг; если документ при этом
оказался неточным — поправить его после фикса.

**#4 `TODO.md` ↔ `DONE.md`.** Закрытая задача **переезжает** в `DONE.md`
(дата + одна строка), а не удаляется и не остаётся как `[x]`. К концу сессии
в `TODO.md` только `[ ]`, `[~]`, `[BLOCKED]`. `DONE.md` — append-only,
в рутинных циклах не читается.

**#5 Где чему лежать.** Логика MCP-инструмента — отдельный модуль
`tools/second-brain-mcp/src/lib/<модуль>.js`; `src/index.js` только объявляет
инструменты и не разрастается. Поведение агента — в `Promts/*.md`
(`SOUL.md` генерируется энтрипойнтом, руками не править). Конфиги, которые
владелец правит без разработчика, — `config/*.json`.

**#6 Тесты** — на детерминированную логику: vault и frontmatter, выбор модели
и цена, парсинг конфигов. Не на обёртки вокруг сети и логирование. Сеть в
тестах подменяется (`fetchImpl`), а не вызывается. Прогон: `make test`
(`bun test` + smoke-проверка списка MCP-инструментов).

**#7 Скилл `/dev`** (`.claude/skills/dev/SKILL.md`) — автопилот одного цикла
разработки по `TODO.md` + `DEV_PLAN.md`.

## Карта документов

| Файл | Что описывает |
|---|---|
| `ТЗ.md` | Технический слой: конвейер слоёв 0–9, Obsidian-vault, MCP-инструменты, дорожная карта §12, открытые вопросы §13 |
| `PRD.md` | Продуктовое ТЗ (BMAD): сценарии UJ-1…7, требования FR-1…9, объём MVP, метрики |
| `README.md` | Стек (hermes + gbrain + Grafify), выбор модели, голос, эксплуатация на amvera |
| `Promts/<слой>.md` | Поведение слоя конвейера; порядок сборки — `Promts/README.md` |
| `TODO.md` / `DONE.md` / `DEV_PLAN.md` | Незакрытое / закрытое / порядок и блокеры |
| `config/layer_policy.json` | Критичность слоёв → бесплатная или платная модель |
| `config/fx.json` | Курс USD→RUB для оценки стоимости вызова |
| `tools/second-brain-mcp/README.md` | MCP-сервер: инструменты, переменные окружения, локальный прогон |

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
