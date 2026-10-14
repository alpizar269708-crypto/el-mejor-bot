FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    GALLERY_DL_PATH=/opt/gallery-dl/bin/gallery-dl

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN case "$(dpkg --print-architecture)" in \
      amd64) export YOUTUBE_DL_HOST=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux ;; \
      arm64) export YOUTUBE_DL_HOST=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 ;; \
      *) echo "Arquitectura no compatible con el binario de yt-dlp" >&2; exit 1 ;; \
    esac \
    && npm install --omit=dev --no-audit --no-fund \
    && python3 -m venv /opt/gallery-dl \
    && /opt/gallery-dl/bin/python -m pip install --disable-pip-version-check --no-cache-dir gallery-dl==1.32.16

COPY --chown=node:node . .
RUN mkdir -p /app/session && chown -R node:node /app

USER node

EXPOSE 3000
CMD ["npm", "start"]
