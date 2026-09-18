# syntax=docker/dockerfile:1
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Public, browser-accessible absolute URL; Vite embeds it at build time.
ARG VITE_AGENT_API_URL=http://localhost:8080
ARG VITE_CONVERTER_URL=http://localhost:5001
ENV VITE_AGENT_API_URL=${VITE_AGENT_API_URL} \
    VITE_CONVERTER_URL=${VITE_CONVERTER_URL}
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
