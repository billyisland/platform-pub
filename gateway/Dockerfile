FROM node:20-alpine
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY gateway/ gateway/
RUN cd shared && npm install && cd ../gateway && npm install
RUN ln -sf /app/shared /app/gateway/shared
# Compile TypeScript to dist/. Catches type errors at image-build time rather
# than letting bad code reach a running container, and removes the per-boot
# tsx transpile cost.
RUN cd gateway && npm run build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "gateway/dist/src/index.js"]
