# DONE — second_brain

Append-only журнал закрытых задач: дата + одна строка «что сделано».
`/dev` не читает этот файл в рутинных циклах.

## 2026-08-21

- Выбор модели: порт слоя из GrowthProducer (`src/llm/*`) в `second-brain-mcp` —
  каталог OpenRouter, топ бесплатных (shir-man + нулевая цена), политика
  критичности слоёв, оценка стоимости вызова; 4 MCP-инструмента, 19 тестов.
- Бесплатный каталог в рантайме: cheap-тир `smart_model_routing` по умолчанию =
  топ-1 бесплатная модель OpenRouter (`docker/entrypoint.sh` + `free-top1.mjs`).
- Слой 10 — импорт истории канала/группы: `import_chat_history`,
  `import_chat_history_file`, `history_import_status`, двойная
  идемпотентность (`.state/history-import.json` + ссылка в файле дня).
- Инфраструктура: SessionStart-хук (`scripts/setup_session.sh`), CI для
  MCP-сервера и shell/JSON (`.github/workflows/ci.yml`), `make test`,
  дисциплина `TODO.md` ↔ `DONE.md` + `DEV_PLAN.md` + скилл `/dev`.

## Ранее (по истории git)

- M1 — базовый конвейер и vault: слои 0–3, 8, 9, `second-brain-mcp`, персоны,
  Obsidian-vault, feedback.
- M2 — консультант: слой 4 целиком, `set_decision_outcome`, фильтр `status`
  в `search_vault` (исходы решений питают прецеденты 4c).
- Стек: hermes-agent + gbrain + Grafify на amvera, голос через Yandex
  SpeechKit, `/model` с провайдером yandex, `smart_model_routing`.
