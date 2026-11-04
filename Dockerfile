FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY agent ./agent
COPY web ./web
COPY packaging ./packaging
ENV PORT=8080 DATA_FILE=/data/db.json
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
