FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY traffology-ingest/ traffology-ingest/
RUN cd shared && npm install && cd ../traffology-ingest && npm install
RUN ln -sf /app/shared /app/traffology-ingest/shared
RUN cd traffology-ingest && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3005
CMD ["node", "traffology-ingest/dist/src/index.js"]
