FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY payment-service/package.json payment-service/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/payment-service --include-workspace-root
COPY shared/ shared/
COPY payment-service/ payment-service/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/payment-service
RUN npm prune --omit=dev
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3001
CMD ["node", "payment-service/dist/index.js"]
