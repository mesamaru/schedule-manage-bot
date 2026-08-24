FROM node:22-alpine
WORKDIR /app

# alpine には tzdata が入っておらず、TZ を設定しても JST に解決できず UTC 扱いになる。
# 予定の時刻表示・入力解釈が JST 前提のため必須。
RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
# scripts/ はコンソールの update コマンド（scripts/update.mjs）から使う
COPY scripts/ ./scripts/

RUN mkdir -p /app/data

CMD ["node", "src/index.js"]
