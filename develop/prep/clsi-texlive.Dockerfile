ARG OVERLEAF_BASE_TAG=sharelatex/sharelatex-base:latest

FROM node:24.13.0 AS app

WORKDIR /overleaf/services/clsi

COPY package.json package-lock.json /overleaf/
COPY libraries/fetch-utils/package.json /overleaf/libraries/fetch-utils/package.json
COPY libraries/logger/package.json /overleaf/libraries/logger/package.json
COPY libraries/metrics/package.json /overleaf/libraries/metrics/package.json
COPY libraries/o-error/package.json /overleaf/libraries/o-error/package.json
COPY libraries/promise-utils/package.json /overleaf/libraries/promise-utils/package.json
COPY libraries/settings/package.json /overleaf/libraries/settings/package.json
COPY libraries/stream-utils/package.json /overleaf/libraries/stream-utils/package.json
COPY services/clsi/package.json /overleaf/services/clsi/package.json
COPY patches/ /overleaf/patches/

RUN cd /overleaf && npm ci --quiet

COPY libraries/fetch-utils/ /overleaf/libraries/fetch-utils/
COPY libraries/logger/ /overleaf/libraries/logger/
COPY libraries/metrics/ /overleaf/libraries/metrics/
COPY libraries/o-error/ /overleaf/libraries/o-error/
COPY libraries/promise-utils/ /overleaf/libraries/promise-utils/
COPY libraries/settings/ /overleaf/libraries/settings/
COPY libraries/stream-utils/ /overleaf/libraries/stream-utils/
COPY services/clsi/ /overleaf/services/clsi/

FROM ${OVERLEAF_BASE_TAG}

WORKDIR /overleaf/services/clsi

COPY --from=app /overleaf /overleaf
COPY server-ce/config/latexmkrc /tmp/LatexMk

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y ghostscript chktex \
 && mkdir -p /usr/local/share/latexmk cache compiles output \
 && mv /tmp/LatexMk /usr/local/share/latexmk/LatexMk

EXPOSE 3013

CMD ["node", "app.js"]
