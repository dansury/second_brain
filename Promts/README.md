# Promts/

Промты для каждого слоя многослойного анализа из [`../ТЗ.md`](../ТЗ.md#6-многослойная-архитектура-анализа).
Один слой — один md-файл. Секретов здесь нет, поэтому файлы свободно
коммитятся и ревьюются как обычный код/документация.

## Формат файла

Каждый промт — обычный markdown с YAML-frontmatter:

```yaml
---
layer: L2               # идентификатор слоя (см. ТЗ.md §6)
model_default: fast      # fast | advisor | vision — алиас, см. ниже
temperature: 0.2
input: "текст сообщения + контекст (см. раздел «Вход» ниже)"
output_schema: person_extraction.schema.json   # см. секцию ```json schema``` в файле
---
```

Алиасы моделей (реальные id задаются переменными окружения, см. `env.example`):

| Алиас | Назначение | Переменная |
|---|---|---|
| `fast` | Дешёвые/быстрые слои классификации (L0–L3) | `SECONDBRAIN_FAST_MODEL` |
| `advisor` | Слои прогноза и синтеза (L4–L5) | `SECONDBRAIN_ADVISOR_MODEL` (по умолчанию — модель основного агента, см. `/model`) |
| `vision` | Разбор фото/видеокадров/почерка | `VISION_MODEL` |

## Список файлов

| Файл | Слой | Когда вызывается |
|---|---|---|
| [`00_ingest_route.md`](./00_ingest_route.md) | L0/L1 | Каждое новое сообщение (текст/расшифрованный голос или видео) |
| [`01_ner_person_extraction.md`](./01_ner_person_extraction.md) | L2 | После L1, если в тексте есть упоминания людей |
| [`02_person_disambiguation.md`](./02_person_disambiguation.md) | L2.5 | Для каждого кандидата из L2 |
| [`03_decision_doubt_extraction.md`](./03_decision_doubt_extraction.md) | L3 | Если L1 классифицировал запись как решение/сомнение |
| [`04_multiperspective_forecast.md`](./04_multiperspective_forecast.md) | L4 | После L3, перед выдачей прогноза |
| [`05_advisor_synthesis.md`](./05_advisor_synthesis.md) | L5 | После L4 — финальный ответ пользователю |
| [`06_feedback_followup.md`](./06_feedback_followup.md) | L6 | По 👎 на любой ответ бота |
| [`07_document_clarifying_questions.md`](./07_document_clarifying_questions.md) | — | Загрузка документа |
| [`08_photo_people_analysis.md`](./08_photo_people_analysis.md) | — | Фото с людьми |
| [`09_handwriting_transcription.md`](./09_handwriting_transcription.md) | — | Фото с рукописным текстом |

`_wiki/` — шаблоны журналов обратной связи (реальные логи пишутся на том
amvera, `Promts/_wiki/*.md` здесь — только пустые шаблоны с заголовком,
закоммиченные для наглядности формата).
