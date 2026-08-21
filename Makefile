# second_brain — удобные команды
.PHONY: help env build up down logs shell graph test memory-status memory-clear

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
