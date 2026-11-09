#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
environment_file="${STAGING_ENV_FILE:-/etc/hirearchy/staging.env}"
log_file="${STAGING_READINESS_LOG:-/var/log/hirearchy/staging-readiness.jsonl}"
app_port="$(node --env-file="$environment_file" -p 'process.env.APP_PORT')"

if [[ ! "$app_port" =~ ^[0-9]{1,5}$ ]] || ((app_port < 1 || app_port > 65535)); then
  printf 'Staging readiness probe configuration is invalid.\n' >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$log_file")"
chmod 0700 "$(dirname -- "$log_file")"
APP_PORT="$app_port" node "$script_dir/check-staging-readiness.mjs" \
  | tee -a "$log_file"
chmod 0600 "$log_file"
