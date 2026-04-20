FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/gateway --include-workspace-root
COPY shared/ shared/
COPY gateway/ gateway/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/gateway
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "gateway/dist/index.js"]
