FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY key-service/package.json key-service/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/key-service --include-workspace-root
COPY shared/ shared/
COPY key-service/ key-service/
RUN npm run build --workspace=@platform-pub/shared && \
    npm run build --workspace=@platform-pub/key-service

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY key-service/package.json key-service/
RUN npm ci --omit=dev --workspace=@platform-pub/shared --workspace=@platform-pub/key-service --include-workspace-root
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/key-service/dist key-service/dist
ENV NODE_ENV=production
USER app
EXPOSE 3002
CMD ["node", "key-service/dist/index.js"]
