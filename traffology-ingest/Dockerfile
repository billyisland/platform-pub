FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY traffology-ingest/package.json traffology-ingest/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/traffology-ingest --include-workspace-root
COPY shared/ shared/
COPY traffology-ingest/ traffology-ingest/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/traffology-ingest
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3005
CMD ["node", "traffology-ingest/dist/index.js"]
