FROM node:22-alpine
# [22/10 BAO-MAT-NODE] Node 20 da het ho tro -> Node 22 LTS. Chan build neu anh goc con Node chua va dot 21/10/2026 (can 22.23.4+).
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&(b<23||(b===23&&c<4)))){console.error('Node '+process.version+' chua va - can 22.23.4+');process.exit(1)}else console.log('Node OK',process.version)"
WORKDIR /app
COPY app.js loader.js index.html ./
ENV DATA_DIR=/data \
    PORT=8080 \
    SERVER=app.lacviet-node.com \
    NODE_HOST=host.docker.internal
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "loader.js"]
