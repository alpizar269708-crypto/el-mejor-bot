FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/node/.cache/puppeteer /app/session \
    && chown -R node:node /home/node/.cache /app

COPY --chown=node:node package.json ./
USER node
RUN npm install --omit=dev --no-audit --no-fund \
    && python3 -m venv /app/.venv \
    && /app/.venv/bin/python -m pip install --disable-pip-version-check --no-cache-dir -U "yt-dlp[default,curl-ffi]" \
    && npx puppeteer browsers install chrome

COPY --chown=node:node . .
EXPOSE 3000
CMD ["npm", "start"]
