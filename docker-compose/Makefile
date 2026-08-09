# SuiviBourse compose helpers. Plain `docker compose` works just as well —
# these targets only save the bootstrap and upgrade incantations.
COMPOSE ?= docker compose
DEV     := $(COMPOSE) -f docker-compose.dev.yaml

.PHONY: help init up down logs pull upgrade config dev dev-down token

help:  ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

init:  ## Create .env (with a unique token) and data/ from the templates
	@test -f .env || { \
		cp .env.example .env; \
		token=$$(openssl rand -hex 32 2>/dev/null \
			|| python3 -c 'import secrets;print(secrets.token_hex(32))' 2>/dev/null); \
		if [ -n "$$token" ]; then \
			sed -i.bak "s|^INFLUXDB_TOKEN=.*|INFLUXDB_TOKEN=apiv3_$$token|" .env && rm -f .env.bak; \
			echo "created .env with a freshly generated INFLUXDB_TOKEN"; \
		else \
			echo "created .env — set INFLUXDB_TOKEN yourself (no openssl/python3 found)"; \
		fi; \
	}
	@test -d data || { cp -r data.example data; echo "created data/"; }
	@grep -q '^SB_UID=' .env || { \
		printf '\n# Ownership of the (writable) config mount — the invoking user.\n' >> .env; \
		printf 'SB_UID=%s\nSB_GID=%s\n' "$$(id -u)" "$$(id -g)" >> .env; \
		echo "recorded SB_UID=$$(id -u) SB_GID=$$(id -g) so the app writes files you own"; \
	}
	@grep -q '^COMPOSE_FILE=' .env || { \
		echo "note: your .env predates the port overlay — no port is published."; \
		echo "      add this line to keep reaching Grafana on the host:"; \
		echo "        Linux/macOS: COMPOSE_FILE=docker-compose.yaml:docker-compose.expose.yaml"; \
		echo "        Windows:     COMPOSE_FILE=docker-compose.yaml;docker-compose.expose.yaml"; \
	}
	@echo "Ready. Drop your broker exports (.csv / .xlsx) into data/events/."

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
