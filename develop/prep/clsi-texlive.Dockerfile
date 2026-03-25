ARG OVERLEAF_BASE_TAG=sharelatex/sharelatex-base:latest

FROM node:24.13.0 AS app

WORKDIR /overleaf/services/clsi

COPY package.json package-lock.json /overleaf/
COPY libraries/fetch-utils/package.json /overleaf/libraries/fetch-utils/package.json
COPY libraries/logger/package.json /overleaf/libraries/logger/package.json
COPY libraries/metrics/package.json /overleaf/libraries/metrics/package.json
COPY libraries/o-error/package.json /overleaf/libraries/o-error/package.json
COPY libraries/overleaf-editor-core/package.json /overleaf/libraries/overleaf-editor-core/package.json
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
COPY libraries/overleaf-editor-core/ /overleaf/libraries/overleaf-editor-core/
COPY libraries/promise-utils/ /overleaf/libraries/promise-utils/
COPY libraries/settings/ /overleaf/libraries/settings/
COPY libraries/stream-utils/ /overleaf/libraries/stream-utils/
COPY services/clsi/ /overleaf/services/clsi/

FROM ${OVERLEAF_BASE_TAG}

ARG TEXLIVE_MIRROR=https://mirror.ox.ac.uk/sites/ctan.org/systems/texlive/tlnet
ARG APT_EXTRA_PACKAGES="\
    ghostscript \
    fonts-nanum fonts-noto-cjk \
    fonts-dejavu fonts-liberation fonts-liberation2 fonts-freefont-ttf \
"
ARG TEXLIVE_EXTRA_PACKAGES="\
    collection-latexextra collection-fontsrecommended collection-latexrecommended \
    collection-mathscience inconsolata fbb newtx ly1 sourcesans \
    cjk-ko xetexko collection-langcjk \
    biblatex biber biblatex-apa biblatex-mla biblatex-ieee biblatex-chicago acmart \
"
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y ${APT_EXTRA_PACKAGES} \
 && tlmgr option repository "${TEXLIVE_MIRROR}" \
 && tlmgr install --repository "${TEXLIVE_MIRROR}" ${TEXLIVE_EXTRA_PACKAGES} \
 && tlmgr path add

ARG TEXLIVE_TEST_PACKAGES=""
RUN tlmgr option repository "${TEXLIVE_MIRROR}" \
 && if [ -n "${TEXLIVE_TEST_PACKAGES}" ]; then \
      tlmgr install --repository "${TEXLIVE_MIRROR}" ${TEXLIVE_TEST_PACKAGES}; \
    fi \
 && tlmgr path add

WORKDIR /overleaf/services/clsi

COPY --from=app /overleaf /overleaf
RUN mkdir -p /usr/local/share/latexmk
COPY server-ce/config/latexmkrc /usr/local/share/latexmk/LatexMk

RUN mkdir -p cache compiles output

EXPOSE 3013

CMD ["node", "app.js"]
