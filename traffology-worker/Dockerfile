FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY traffology-worker/package.json traffology-worker/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/traffology-worker --include-workspace-root
COPY shared/ shared/
COPY traffology-worker/ traffology-worker/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/traffology-worker
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
CMD ["node", "traffology-worker/dist/index.js"]
