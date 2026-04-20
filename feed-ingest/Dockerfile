FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY feed-ingest/package.json feed-ingest/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/feed-ingest --include-workspace-root
COPY shared/ shared/
COPY feed-ingest/ feed-ingest/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/feed-ingest
RUN npm prune --omit=dev
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
CMD ["node", "feed-ingest/dist/index.js"]
