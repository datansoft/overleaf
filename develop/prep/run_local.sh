#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

docker build \
  -f ../server-ce/Dockerfile-base \
  -t sharelatex/sharelatex-base:latest \
  ..

docker-compose -f docker-compose.yml -f docker-compose.dev.yml "$@"
