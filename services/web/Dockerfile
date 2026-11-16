# syntax=docker/dockerfile:1
# Unprivileged nginx: runs as uid 101, listens on 8080, no root needed.
FROM nginxinc/nginx-unprivileged:1.27-alpine

ENV API_UPSTREAM=http://api:8000 \
    MAX_UPLOAD_MB=200 \
    NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|MAX_UPLOAD_MB)$"

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY html /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
