FROM docker:27-cli
RUN apk add --no-cache nodejs docker-cli-compose
WORKDIR /app
COPY server.mjs .
CMD ["/usr/bin/node", "server.mjs"]
