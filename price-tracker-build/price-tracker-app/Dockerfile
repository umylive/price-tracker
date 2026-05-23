FROM node:20-alpine

RUN apk add --no-cache python3 make g++ tini

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
