FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY traffology-worker/ traffology-worker/
RUN cd shared && npm install && cd ../traffology-worker && npm install
RUN ln -sf /app/shared /app/traffology-worker/shared
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
CMD ["./traffology-worker/node_modules/.bin/tsx", "traffology-worker/src/index.ts"]
