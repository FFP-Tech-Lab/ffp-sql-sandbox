# Digest-pinned Node 22 slim (linux index digest from Docker Hub, 2026-08-25).
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /sandbox

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY execute.js stream-limit.js session-setup.js secrets.js events.js pg-query-stream.js mysql-query-stream.js query-watchdog.js ./

USER node

ENTRYPOINT ["node", "execute.js"]
