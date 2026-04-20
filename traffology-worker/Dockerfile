FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY traffology-worker/ traffology-worker/
RUN cd shared && npm install && cd ../traffology-worker && npm install
RUN ln -sf /app/shared /app/traffology-worker/shared
RUN cd traffology-worker && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
CMD ["node", "traffology-worker/dist/src/index.js"]
