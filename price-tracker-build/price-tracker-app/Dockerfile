FROM node:24-slim

# chromium pulls all glibc deps that Puppeteer's bundled Chrome needs at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ tini \
    chromium \
    && rm -rf /var/lib/apt/lists/*

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

ENTRYPOINT ["tini", "--"]
CMD ["node", "backend/server.js"]
