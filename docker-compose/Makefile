# SuiviBourse compose helpers. Plain `docker compose` works just as well —
# these targets only save the bootstrap and upgrade incantations.
COMPOSE ?= docker compose
DEV     := $(COMPOSE) -f docker-compose.dev.yaml

.PHONY: help init up down logs pull upgrade config dev dev-down token

help:  ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

init:  ## Create .env and data/ from the shipped templates (never overwrites)
	@test -f .env || { cp .env.example .env; echo "created .env"; }
	@test -d data || { cp -r data.example data; echo "created data/"; }
	@echo "Ready. Edit data/config.yaml, or drop broker exports into data/events/."

up: init  ## Start the stack
	$(COMPOSE) up -d

down:  ## Stop the stack (data volumes are kept)
	$(COMPOSE) down

logs:  ## Follow the app logs
	$(COMPOSE) logs -f app

pull:  ## Fetch the image for the pinned SB_VERSION
	$(COMPOSE) pull

upgrade: pull  ## Pull and restart on the pinned SB_VERSION
	$(COMPOSE) up -d

config:  ## Render the resolved compose file (validates .env)
	$(COMPOSE) config

token:  ## Print a fresh InfluxDB admin token to paste into .env
	@echo "apiv3_$$(openssl rand -hex 32)"

dev:  ## Start the development stack (local build, no auth, docs on :4000)
	$(DEV) up -d --build

dev-down:  ## Stop the development stack
	$(DEV) down
