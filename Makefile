# second_brain — удобные команды
.PHONY: help env build up down logs shell graph test memory-status memory-clear \
	hermes-status hermes-check hermes-update hermes-rollback \
	snapshot snapshots restore

help:
	@echo "make env    — создать .env из env.example"
	@echo "make build  — собрать docker-образ"
	@echo "make up     — запустить бота локально (docker compose)"
	@echo "make down   — остановить"
	@echo "make logs   — логи бота"
	@echo "make shell  — shell внутри контейнера"
	@echo "make graph  — построить граф Grafify по репозиторию"
	@echo "make test   — тесты MCP-сервера (bun) + smoke-проверка списка инструментов"
	@echo "make memory-status — состояние памяти gbrain (в контейнере)"
	@echo "make memory-clear  — полностью очистить память gbrain (в контейнере)"
	@echo ""
	@echo "Версия ядра hermes (закреплена в config/hermes/base-image.env):"
	@echo "make hermes-status   — что закреплено, что в апстриме"
	@echo "make hermes-check    — есть ли новое ядро (код 10 = есть)"
	@echo "make hermes-update   — закрепить новую версию ядра"
	@echo "make hermes-rollback — вернуть предыдущую версию ядра"
	@echo ""
	@echo "Накопленные данные (мозг, vault, граф) — снимки и откат:"
	@echo "make snapshots       — список снимков (в контейнере)"
	@echo "make snapshot        — снять снимок сейчас (в контейнере)"
	@echo "make restore ID=<id> — восстановить состояние из снимка"

env:
	@test -f .env || (cp env.example .env && echo "Создан .env — заполните ключи")

build:
	docker compose build

up: env
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f bot

shell:
	docker compose exec bot bash

graph:
	bash scripts/build-graph.sh .

test:
	cd tools/second-brain-mcp && bun install && bun test && bun run scripts/smoke-list-tools.mjs

memory-status:
	docker compose exec bot bash /opt/second_brain/scripts/memory.sh status

memory-clear:
	docker compose exec bot bash /opt/second_brain/scripts/memory.sh clear

# --- Версия ядра hermes ------------------------------------------------------
# Работают в репозитории: правят пин, а не запущенный контейнер. Чтобы новая
# версия доехала до прода, изменения нужно закоммитить и передеплоить.
hermes-status:
	bash scripts/hermes-update.sh status

hermes-check:
	bash scripts/hermes-update.sh check

hermes-update:
	bash scripts/hermes-update.sh update

hermes-rollback:
	bash scripts/hermes-update.sh rollback

# --- Снимки накопленного состояния -------------------------------------------
# Работают в контейнере: данные живут в томе, а не в репозитории.
snapshots:
	docker compose exec bot bash /opt/second_brain/scripts/state-snapshot.sh list

snapshot:
	docker compose exec bot bash /opt/second_brain/scripts/state-snapshot.sh create manual

restore:
	@test -n "$(ID)" || (echo "Укажите снимок: make restore ID=<id> (список: make snapshots)"; exit 1)
	docker compose exec bot bash /opt/second_brain/scripts/state-snapshot.sh restore "$(ID)"
