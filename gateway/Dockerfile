FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY gateway/ gateway/
RUN cd shared && npm install && cd ../gateway && npm install
RUN ln -sf /app/shared /app/gateway/shared
ENV NODE_ENV=production
EXPOSE 3000
CMD ["./gateway/node_modules/.bin/tsx", "gateway/src/index.ts"]
