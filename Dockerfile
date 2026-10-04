# Every dependency (MemWal beta, AI SDK) is installed INSIDE the image, nothing on the host.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY test ./test
COPY mock-sharepoint ./mock-sharepoint
COPY mock-data ./mock-data

# Writable dirs: usage log, chat-session state, offline KB fallback.
RUN mkdir -p /app/logs /app/state /app/kb-cache && chown -R node:node /app/logs /app/state /app/kb-cache
USER node

CMD ["node", "src/index.js"]
