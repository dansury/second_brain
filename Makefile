# second_brain — удобные команды
.PHONY: help env build up down logs shell graph

help:
	@echo "make env    — создать .env из env.example"
	@echo "make build  — собрать docker-образ"
	@echo "make up     — запустить бота локально (docker compose)"
	@echo "make down   — остановить"
	@echo "make logs   — логи бота"
	@echo "make shell  — shell внутри контейнера"
	@echo "make graph  — построить граф Grafify по репозиторию"

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
