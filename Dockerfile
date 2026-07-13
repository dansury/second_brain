# =============================================================================
# second_brain — единый образ Telegram-бота для amvera.ru
# =============================================================================
# Базируется на официальном образе hermes-agent (Telegram-шлюз, s6-overlay,
# python + node уже внутри) и добавляет:
#   • bun + gbrain  — долговременная память (MCP stdio-сервер)
#   • graphify      — граф знаний по коду в изолированном venv (MCP)
#   • cont-init хук  — сборка config.yaml из переменных окружения на старте
#
# Ядро LLM — OpenRouter; эмбеддинги памяти — Yandex Cloud (см. env.example).
# =============================================================================
FROM nousresearch/hermes-agent:latest

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

# --- Yandex SpeechKit: command-провайдеры STT/TTS для hermes -----------------
# hermes вызывает эти скрипты как основной движок голоса (см. entrypoint).
COPY speechkit/ /opt/second_brain/speechkit/
RUN chmod +x /opt/second_brain/speechkit/*.sh

# --- Grafify: зашитый граф этого репозитория (MCP-инструмент включён) --------
# hermes поднимает graphify.serve на этом графе (GRAFIFY_ENABLED=true).
# Свой граф пользователь может смонтировать в /opt/data/graphify-out/.
COPY graphify-out/ /opt/second_brain/graphify-out/

# --- Служебные скрипты (управление памятью и пр.) ---------------------------
COPY scripts/ /opt/second_brain/scripts/
RUN chmod +x /opt/second_brain/scripts/*.sh

# --- Хук инициализации: собрать config.yaml из окружения до старта сервисов --
# s6-overlay выполняет /etc/cont-init.d/* от root перед запуском gateway.
COPY docker/entrypoint.sh /etc/cont-init.d/50-second-brain
RUN chmod +x /etc/cont-init.d/50-second-brain

# Постоянные данные (мозг gbrain, граф, состояние hermes) живут здесь.
# amvera монтирует персистентный том сюда (persistenceMount: /opt/data).
ENV HERMES_HOME=/opt/data
ENV GBRAIN_HOME=/opt/data/gbrain
ENV GRAFIFY_PYTHON=/opt/tools/gfx/bin/python

# ENTRYPOINT (/init + main-wrapper) наследуется из базового образа.
# CMD запускает мессенджер-шлюз (Telegram и др. по заданным переменным).
CMD ["gateway", "run"]
