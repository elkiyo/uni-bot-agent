# Keeper runtime — deployable to any VPS/container host (Hostinger, Fly.io,
# Railway, ...). State lives in /app/data: mount a volume there or the vault
# api_keys are lost on redeploy (see agent/README.md).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# tsx is a devDependency; the production image runs it via npx (pinned).
RUN npm install --no-save tsx@4

VOLUME /app/data

CMD ["npx", "tsx", "src/index.ts"]
