#!/bin/sh
set -eu

TEMPLATE_FILE="/etc/nginx/conf.d/default.conf.template"
OUTPUT_FILE="/etc/nginx/conf.d/default.conf"
UPSTREAM="${BACKEND_UPSTREAM:-backend:3001}"

escaped_upstream=$(printf '%s' "$UPSTREAM" | sed 's/[&/\\]/\\&/g')
sed "s/__BACKEND_UPSTREAM__/${escaped_upstream}/g" "$TEMPLATE_FILE" > "$OUTPUT_FILE"

exec nginx -g 'daemon off;'
