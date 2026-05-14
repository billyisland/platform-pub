FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY payment-service/package.json payment-service/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/payment-service --include-workspace-root
COPY shared/ shared/
COPY payment-service/ payment-service/
RUN npm run build --workspace=@platform-pub/shared && \
    npm run build --workspace=@platform-pub/payment-service

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY payment-service/package.json payment-service/
RUN npm ci --omit=dev --workspace=@platform-pub/shared --workspace=@platform-pub/payment-service --include-workspace-root
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/payment-service/dist payment-service/dist
ENV NODE_ENV=production
USER app
EXPOSE 3001
CMD ["node", "payment-service/dist/index.js"]
