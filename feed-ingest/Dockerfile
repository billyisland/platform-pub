FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY feed-ingest/ feed-ingest/
RUN cd shared && npm install && cd ../feed-ingest && npm install
RUN ln -sf /app/shared /app/feed-ingest/shared
RUN cd feed-ingest && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
CMD ["node", "feed-ingest/dist/src/index.js"]
