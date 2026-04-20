FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY payment-service/ payment-service/
RUN cd shared && npm install && cd ../payment-service && npm install
RUN ln -sf /app/shared /app/payment-service/shared
RUN cd payment-service && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3001
CMD ["node", "payment-service/dist/src/index.js"]
