#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

# A private pair is needed for TLS and password-free, disposable authentication.
# Random names and loopback ports keep this fixture separate from shared DB lanes.
fixture=$(mktemp -d /private/tmp/spike220-pool.XXXXXXXX)
network="spike220-${fixture##*.}"
postgres="${network}-postgres"
pool="${network}-pool"
cleanup() {
  local status=$?
  trap - EXIT
  docker rm -f -v "$pool" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$fixture"
  for name in "$pool" "$postgres"; do
    if docker container inspect "$name" >/dev/null 2>&1; then status=1; fi
  done
  if ! docker info >/dev/null 2>&1 || [[ -e "$fixture" ]]; then status=1; fi
  if docker network inspect "$network" >/dev/null 2>&1; then status=1; fi
  if (( status == 0 )); then
    printf '%s\n' 'Verified local fixture containers, network and TLS files removed.'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

image='edoburu/pgbouncer@sha256:4a8371e79d6627e74f553d0aaa8e4c5ace20e30034fb296e569b71c89c99e108'
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1' -keyout "$fixture/tls.key" -out "$fixture/tls.crt" 2>/dev/null
cat > "$fixture/users" <<'USERS'
"spike220_fixture" ""
"spike220_runner_123456abcdef" ""
USERS
cat > "$fixture/pgbouncer.ini" <<'CONFIG'
[databases]
spike220_fixture = host=postgres port=5432 dbname=spike220_fixture
[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
pool_mode = transaction
default_pool_size = 20
max_client_conn = 64
auth_type = trust
auth_file = /tmp/spike220/users
admin_users = spike220_fixture
client_tls_sslmode = require
client_tls_cert_file = /tmp/spike220/tls.crt
client_tls_key_file = /tmp/spike220/tls.key
CONFIG
docker network create "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" --network-alias postgres \
  -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql:rw,size=536870912 \
  -e POSTGRES_USER=spike220_fixture -e POSTGRES_DB=spike220_fixture \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18.6-alpine3.24 >/dev/null
for ((i=0;i<30;i++)); do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U spike220_fixture -d spike220_fixture >/dev/null; then break; fi
  sleep 1
done
docker exec "$postgres" pg_isready -h 127.0.0.1 -U spike220_fixture -d spike220_fixture >/dev/null
docker run -d --name "$pool" --network "$network" -p 127.0.0.1::6432 \
  --user 0 --entrypoint sh -v "$fixture:/fixture:ro" "$image" -c '
    mkdir /tmp/spike220
    cp /fixture/* /tmp/spike220/
    chown -R postgres:postgres /tmp/spike220
    chmod 600 /tmp/spike220/tls.key
    exec pgbouncer -u postgres /tmp/spike220/pgbouncer.ini' >/dev/null
for ((i=0;i<30;i++)); do
  if docker exec "$pool" pg_isready -h 127.0.0.1 -p 6432 -U spike220_fixture -d spike220_fixture >/dev/null; then break; fi
  sleep 1
done
docker exec "$pool" pg_isready -h 127.0.0.1 -p 6432 -U spike220_fixture -d spike220_fixture >/dev/null
postgres_address=$(docker port "$postgres" 5432/tcp)
pool_address=$(docker port "$pool" 6432/tcp)
docker exec "$pool" pgbouncer --version | head -1
NODE_EXTRA_CA_CERTS="$fixture/tls.crt" SPIKE220_LOCAL_POSTGRES_PORT="${postgres_address##*:}" \
  SPIKE220_LOCAL_POOL_PORT="${pool_address##*:}" node scripts/spikes/220-hosted/local-db.mjs
