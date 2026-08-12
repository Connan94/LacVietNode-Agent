FROM node:20-alpine
WORKDIR /app
COPY app.js loader.js index.html ./
ENV DATA_DIR=/data \
    PORT=8080 \
    SERVER=app.lacviet-node.com \
    NODE_HOST=host.docker.internal
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "loader.js"]
