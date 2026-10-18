# SLightSFTP headless server: web admin GUI + SFTP / FTP listeners
# docker run -d -p 3000:3000 -p 2222:2222 -v slightsftp:/data ghcr.io/slightlabs/slightsftp

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    WEB_PORT=3000 \
    SLIGHTSFTP_CERT_DIR=/data \
    FTP_PASV_MIN=30000 \
    FTP_PASV_MAX=30009
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets

# config.db, keys, certificates and the recycle bin live in /data;
# mount the folders you want to share (e.g. -v /srv/files:/files)
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
VOLUME ["/data"]

EXPOSE 3000 2222 2121 30000-30009
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/dist/web-only.js"]
