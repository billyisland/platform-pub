FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY key-service/ key-service/
RUN cd shared && npm install && cd ../key-service && npm install
RUN ln -sf /app/shared /app/key-service/shared
RUN cd key-service && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3002
CMD ["node", "key-service/dist/src/index.js"]
