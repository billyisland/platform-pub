FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY key-service/package.json key-service/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/key-service --include-workspace-root
COPY shared/ shared/
COPY key-service/ key-service/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/key-service
RUN npm prune --omit=dev
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3002
CMD ["node", "key-service/dist/index.js"]
