include .env
export

cmd-exists-%:
	@hash $(*) > /dev/null 2>&1 || \
		(echo "ERROR: '$(*)' must be installed and available on your PATH."; exit 1)

generate-config: cmd-exists-yq
	yq e -i '.scrape_configs[0].scrape_interval = "${SCRAPING_INTERVAL}s"' prometheus_provisioning/prometheus.yml
	yq e -i '.scrape_configs[0].static_configs[0].targets[0] = "app:${METRICS_PORT}"' prometheus_provisioning/prometheus.yml

reset-config: cmd-exists-yq
	yq e -i '.scrape_configs[0].scrape_interval = "120s"' prometheus_provisioning/prometheus.yml
	yq e -i '.scrape_configs[0].static_configs[0].targets[0] = "app:8081"' prometheus_provisioning/prometheus.yml

run: cmd-exists-docker-compose generate-config
	docker-compose up --detach

stop: cmd-exists-docker-compose
	docker-compose stop

down: cmd-exists-docker-compose
	docker-compose down