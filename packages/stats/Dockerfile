# palserver 統計後端(Zeabur)。零執行期依賴:Node 24 內建 node:sqlite,並可直接跑 .ts(型別剝除)。
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/stats.sqlite
COPY package.json schema.sql ./
COPY src ./src
EXPOSE 8080
CMD ["node", "src/server.ts"]
