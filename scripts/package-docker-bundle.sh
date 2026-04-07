#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${ROOT_DIR}/release"
TIMESTAMP="$(date -u +"%Y%m%d_%H%M%S")"
ARCHIVE_NAME="redeem-docker-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}"

mkdir -p "${OUTPUT_DIR}"

cd "${ROOT_DIR}"

tar \
  -czf "${ARCHIVE_PATH}" \
  Dockerfile \
  docker-compose.yml \
  .dockerignore \
  package.json \
  package-lock.json \
  src \
  ui/package.json \
  ui/package-lock.json \
  ui/components.json \
  ui/vite.config.ts \
  ui/tsconfig.json \
  ui/tsconfig.app.json \
  ui/tsconfig.node.json \
  ui/index.html \
  ui/eslint.config.js \
  ui/public \
  ui/src

printf 'Created %s\n' "${ARCHIVE_PATH}"
