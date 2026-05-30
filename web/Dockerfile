FROM node:20-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
ARG NEXT_PUBLIC_RELAY_URL
ARG NEXT_PUBLIC_GATEWAY_URL
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
# next.config.js rewrites() is evaluated at BUILD time and baked into
# .next/routes-manifest.json — so GATEWAY_URL must be present here, not just at
# runtime, or the /api proxy destination falls back to localhost:3000 (which,
# inside the container, is the web service itself → ECONNRESET on every API call).
ARG GATEWAY_URL
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV GATEWAY_URL=$GATEWAY_URL
RUN npm run build

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/package.json /app/next.config.js ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/.next .next
COPY --from=build /app/public public
ENV NODE_ENV=production
USER app
EXPOSE 3000
CMD ["npm", "start"]
