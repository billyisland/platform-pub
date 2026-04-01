FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY key-custody/ key-custody/
RUN cd shared && npm install && cd ../key-custody && npm install
RUN ln -sf /app/shared /app/key-custody/shared
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 3004
CMD ["./key-custody/node_modules/.bin/tsx", "key-custody/src/index.ts"]
