FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY key-custody/package.json key-custody/
RUN npm ci --workspace=@platform-pub/shared --workspace=@platform-pub/key-custody --include-workspace-root
COPY shared/ shared/
COPY key-custody/ key-custody/
RUN npm run build --workspace=@platform-pub/shared
RUN npm run build --workspace=@platform-pub/key-custody
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3004
CMD ["node", "key-custody/dist/index.js"]
