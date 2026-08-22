# =============================================================================
# second_brain — единый образ Telegram-бота для amvera.ru
# =============================================================================
# Базируется на официальном образе hermes-agent (Telegram-шлюз, s6-overlay,
# python + node уже внутри) и добавляет:
#   • bun + gbrain      — долговременная память (MCP stdio-сервер)
#   • graphify          — граф знаний по коду в изолированном venv (MCP)
#   • second-brain-mcp  — дневник-консультант: персоны/vault/feedback (см. ТЗ.md)
#   • cont-init хук      — сборка config.yaml + SOUL.md из окружения на старте
#
# Ядро LLM — OpenRouter; эмбеддинги памяти — Yandex Cloud (см. env.example).
# =============================================================================
# >>> hermes-base-pin — управляется scripts/hermes-update.sh, вручную не править
# Базовый образ закреплён по digest: пересборка на amvera всегда даёт ту же
# версию ядра. Обновление и откат — scripts/hermes-update.sh (см.
# config/hermes/base-image.env). Тег в ссылке только для читаемости, тянется
# digest. Переопределить на одну сборку: --build-arg HERMES_BASE_REF=...
ARG HERMES_BASE_REF=nousresearch/hermes-agent:v2026.8.19@sha256:3811ed13da874fba2ac99b6d492db9a203d34cb6dccf90d886948c00d0ccec09
# <<< hermes-base-pin
FROM ${HERMES_BASE_REF}

# Версия ядра, зашитая в образ: entrypoint сравнивает её с записанной в томе и
# при расхождении делает снимок накопленных данных ДО старта новой версии.
ARG HERMES_BASE_REF

USER root

# --- Системные зависимости для сборки нативных модулей bun/gbrain ------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        unzip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- bun + gbrain (глобально, на общий PATH /usr/local/bin) ------------------
# BUN_INSTALL=/usr/local => bun и gbrain оказываются в /usr/local/bin,
# доступном пользователю hermes (UID 10000), от которого s6 запускает шлюз.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash \
    && bun --version \
    && bun install -g github:garrytan/gbrain \
    && gbrain --version || echo "gbrain: проверьте вывод сборки"

# --- graphify в изолированном venv (не смешиваем с venv hermes) --------------
# Канонический запуск MCP Grafify: python -m graphify.serve <graph.json>
RUN python3 -m venv /opt/tools/gfx \
    && /opt/tools/gfx/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/tools/gfx/bin/pip install --no-cache-dir "graphifyy[mcp]" \
    && /opt/tools/gfx/bin/graphify --help >/dev/null 2>&1 || true

# --- Smart model routing: плагин hermes-smart-model-routing (опционально) ----
# Тиро-роутинг основной модели по сложности входа. Ставится в образ, но
# АКТИВИРУЕТСЯ только при SMART_ROUTING_ENABLED=true (entrypoint пишет блок
# smart_model_routing в config.yaml). Установка терпима к сбою (|| true), как у
# graphify: сток-деплой не зависит от доступности внешнего репозитория на сборке.
# Полная активация плагина зависит от core-хука hermes (см. README плагина).
RUN pip install --no-cache-dir \
        "git+https://github.com/Waylish/hermes-smart-model-routing" \
        >/dev/null 2>&1 || echo "smart-model-routing: плагин не установлен (опционально)"

# --- Yandex SpeechKit: command-провайдеры STT/TTS для hermes -----------------
# hermes вызывает эти скрипты как основной движок голоса (см. entrypoint).
COPY speechkit/ /opt/second_brain/speechkit/
RUN chmod +x /opt/second_brain/speechkit/*.sh

# --- second-brain-mcp: MCP-сервер дневника-консультанта (см. ТЗ.md) ---------
# Персоны, запись в Obsidian-vault, feedback, выбор модели (топ бесплатных
# OpenRouter, цена вызова, политика слоёв).
# Тот же bun, что и для gbrain (BUN_INSTALL=/usr/local выше).
COPY tools/second-brain-mcp/ /opt/second_brain/tools/second-brain-mcp/
RUN cd /opt/second_brain/tools/second-brain-mcp && bun install --production

# --- config/: политика слоёв и курс валюты ----------------------------------
# layer_policy.json (какие слои живут на бесплатной модели) и fx.json (USD→RUB
# для оценки стоимости вызова) читает MCP-сервер по SECOND_BRAIN_DIR. Без них
# он деградирует в «все слои некритичны, курс 90», что не то, что задумано.
COPY config/ /opt/second_brain/config/

# --- Promts: многослойный промт конвейера second_brain (ТЗ.md §9) -----------
# entrypoint.sh собирает эти файлы в $HERMES_HOME/SOUL.md при каждом старте.
COPY Promts/ /opt/second_brain/Promts/

# --- Grafify: зашитый граф этого репозитория (MCP-инструмент включён) --------
# hermes поднимает graphify.serve на этом графе (GRAFIFY_ENABLED=true).
# Свой граф пользователь может смонтировать в /opt/data/graphify-out/.
COPY graphify-out/ /opt/second_brain/graphify-out/

# --- Служебные скрипты (управление памятью и пр.) ---------------------------
COPY scripts/ /opt/second_brain/scripts/
RUN chmod +x /opt/second_brain/scripts/*.sh

# --- Отпечаток версии ядра в образе -----------------------------------------
# entrypoint читает этот файл и сравнивает с /opt/data/.second_brain/state.json.
# Если версия сменилась — перед стартом делается снимок накопленных данных
# (мозг gbrain, vault, конфиг), чтобы обновление можно было откатить.
# (сам config/hermes/base-image.env уже попал в образ вместе с COPY config/ выше)
RUN printf '%s\n' "${HERMES_BASE_REF}" > /opt/second_brain/BASE_IMAGE
LABEL org.opencontainers.image.base.name="${HERMES_BASE_REF}"

# --- Хук инициализации: собрать config.yaml из окружения до старта сервисов --
# s6-overlay выполняет /etc/cont-init.d/* от root перед запуском gateway.
COPY docker/entrypoint.sh /etc/cont-init.d/50-second-brain
RUN chmod +x /etc/cont-init.d/50-second-brain

# Постоянные данные (мозг gbrain, граф, состояние hermes) живут здесь.
# amvera монтирует персистентный том сюда (persistenceMount: /opt/data).
ENV HERMES_HOME=/opt/data
ENV GBRAIN_HOME=/opt/data/gbrain
ENV GRAFIFY_PYTHON=/opt/tools/gfx/bin/python
ENV VAULT_PATH=/opt/data/vault

# ENTRYPOINT (/init + main-wrapper) наследуется из базового образа.
# CMD запускает мессенджер-шлюз (Telegram и др. по заданным переменным).
CMD ["gateway", "run"]
