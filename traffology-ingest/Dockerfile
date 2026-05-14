FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY traffology-ingest/package.json traffology-ingest/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/traffology-ingest --include-workspace-root
COPY shared/ shared/
COPY traffology-ingest/ traffology-ingest/
RUN npm run build --workspace=@platform-pub/shared && \
    npm run build --workspace=@platform-pub/traffology-ingest

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY traffology-ingest/package.json traffology-ingest/
RUN npm ci --omit=dev --workspace=@platform-pub/shared --workspace=@platform-pub/traffology-ingest --include-workspace-root
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/traffology-ingest/dist traffology-ingest/dist
ENV NODE_ENV=production
USER app
EXPOSE 3005
CMD ["node", "traffology-ingest/dist/index.js"]
