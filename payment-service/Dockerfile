FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY payment-service/ payment-service/
RUN cd shared && npm install && cd ../payment-service && npm install
RUN ln -sf /app/shared /app/payment-service/shared
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 3001
CMD ["./payment-service/node_modules/.bin/tsx", "payment-service/src/index.ts"]
