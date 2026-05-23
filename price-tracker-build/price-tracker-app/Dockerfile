FROM node:24-alpine

RUN apk add --no-cache \
    python3 make g++ tini \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

COPY backend ./backend
COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
