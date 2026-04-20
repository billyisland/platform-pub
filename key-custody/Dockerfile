FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY key-custody/ key-custody/
RUN cd shared && npm install && cd ../key-custody && npm install
RUN ln -sf /app/shared /app/key-custody/shared
RUN cd key-custody && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3004
CMD ["node", "key-custody/dist/src/index.js"]
