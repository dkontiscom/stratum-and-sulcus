FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY sync.mjs .
ENTRYPOINT ["node", "sync.mjs"]
