#!/bin/sh
set -eu

BACKEND_UPSTREAM_VALUE="${BACKEND_UPSTREAM:-qca-backend:3001}"

sed "s|__BACKEND_UPSTREAM__|${BACKEND_UPSTREAM_VALUE}|g" \
  /etc/nginx/conf.d/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
