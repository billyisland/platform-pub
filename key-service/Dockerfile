FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY key-service/ key-service/
RUN cd shared && npm install && cd ../key-service && npm install
RUN ln -sf /app/shared /app/key-service/shared
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 3002
CMD ["./key-service/node_modules/.bin/tsx", "key-service/src/index.ts"]
