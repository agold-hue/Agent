# Workmate: one long-running service (API + console + worker pool + scheduler + browsers).
# The Playwright base image carries Chromium and every system library it needs.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY db ./db
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.56.1-noble
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
