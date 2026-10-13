# couchmatch — keine npm-Abhängigkeiten, daher reicht ein einziger Stage.
# Alle Daten (Katalog, Sessions, SQLite mit Konten) liegen im Volume /data.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8095 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/meta').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node:sqlite (Konten & Watchlists) gilt in Node 22 noch als experimentell
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
