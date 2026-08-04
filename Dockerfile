FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /app/output && chown -R node:node /app

USER node

ENV OUTPUT_DIR=/app/output

CMD ["node", "src/index.js"]
