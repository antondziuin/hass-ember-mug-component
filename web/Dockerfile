# Local history server, with the app bundled in.
#
# Node 24 has node:sqlite unflagged, so no build tools and no native modules are needed.
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV DATA_DIR=/data \
    PORT=41821 \
    HOST=0.0.0.0

VOLUME /data
EXPOSE 41821

# HOST is not loopback here, so the server requires AUTH_TOKEN and refuses to start
# without one rather than exposing a writable database to the network.
CMD ["node", "server/src/index.js", "--serve-static", "/app/dist"]
