cmd-exists-%:
	@hash $(*) > /dev/null 2>&1 || \
		(echo "ERROR: '$(*)' must be installed and available on your PATH."; exit 1)

dev: cmd-exists-yq
	yq e -i '.services.app.image = "paulbrissaud/suivi-bourse-app:dev"' docker-compose/docker-compose.yaml
