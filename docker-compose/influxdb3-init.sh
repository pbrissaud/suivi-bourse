#!/bin/bash
set -e

DATA_DIR="${INFLUXDB3_DATA_DIR:-/var/lib/influxdb3}"
DATABASE="${INFLUXDB3_DATABASE:-suivi_bourse}"
NODE_ID="${INFLUXDB3_NODE_ID:-suivi-bourse}"
TOKEN_FILE="${INFLUXDB3_ADMIN_TOKEN_FILE:-}"
ADMIN_TOKEN_VALUE="${SB_INFLUXDB_ADMIN_TOKEN:-}"
WITHOUT_AUTH="${INFLUXDB3_WITHOUT_AUTH:-false}"

# The admin token has a single source of truth: INFLUXDB_TOKEN in .env, handed
# over as SB_INFLUXDB_ADMIN_TOKEN (deliberately not INFLUXDB3_-prefixed, so it
# cannot collide with influxdb3's own env parsing). Materialise the token file it
# from it, so rotating the token is a one-line edit rather than three files kept
# in sync (token file, Grafana datasource, .env).
if [ "$WITHOUT_AUTH" != "true" ] && [ -n "$ADMIN_TOKEN_VALUE" ] && [ -z "$TOKEN_FILE" ]; then
  TOKEN_FILE=/tmp/influxdb3-admin-token.json
  umask 077
  cat > "$TOKEN_FILE" <<EOF
{
  "token": "$ADMIN_TOKEN_VALUE",
  "name": "_admin",
  "description": "SuiviBourse admin token (generated from INFLUXDB_TOKEN)"
}
EOF
  umask 022
fi

# Build serve command
SERVE_ARGS="--node-id=$NODE_ID --object-store=file --data-dir=$DATA_DIR"

if [ "$WITHOUT_AUTH" = "true" ]; then
  SERVE_ARGS="$SERVE_ARGS --without-auth"
  echo "Starting InfluxDB 3 WITHOUT authentication (dev mode)..."
elif [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
  SERVE_ARGS="$SERVE_ARGS --admin-token-file=$TOKEN_FILE"
  echo "Starting InfluxDB 3 with preconfigured admin token..."
  # Extract token from JSON for use in CLI commands
  ADMIN_TOKEN=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$TOKEN_FILE" | sed 's/"token"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
else
  echo "Starting InfluxDB 3 (will need to create token manually)..."
fi

# Start InfluxDB 3 in the background
influxdb3 serve $SERVE_ARGS &
INFLUX_PID=$!

# Wait for InfluxDB to be ready
echo "Waiting for InfluxDB 3 to start..."
for i in {1..30}; do
  if curl -s http://localhost:8181/health > /dev/null 2>&1; then
    echo "InfluxDB 3 is ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "Timeout waiting for InfluxDB 3"
    exit 1
  fi
  sleep 1
done

# Create database if it doesn't exist.
# Only tolerate the "already exists" case; surface any other failure (wrong
# token, auth required, network) instead of masking it behind a generic message.
echo "Creating database: $DATABASE"
if [ -n "$ADMIN_TOKEN" ]; then
  CREATE_OUTPUT=$(influxdb3 create database "$DATABASE" --token "$ADMIN_TOKEN" 2>&1)
else
  CREATE_OUTPUT=$(influxdb3 create database "$DATABASE" 2>&1)
fi || {
  if echo "$CREATE_OUTPUT" | grep -qi "already exists"; then
    echo "Database already exists"
  else
    echo "Failed to create database: $CREATE_OUTPUT"
    exit 1
  fi
}

echo "============================================"
echo "InfluxDB 3 initialized"
echo "Database: $DATABASE"
echo "Port: 8181"
[ "$WITHOUT_AUTH" = "true" ] && echo "Auth: DISABLED (dev mode)"
echo "============================================"

# Wait for the main process
wait $INFLUX_PID
