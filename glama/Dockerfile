# Build used by Glama to start localfig and run MCP introspection (initialize, tools/list).
# Introspection needs no Figma: the server answers it without the plugin connected.
# Build context is the repository root:  docker build -f glama/Dockerfile .
FROM node:22-alpine

WORKDIR /app

# localfig has no npm dependencies, so there is nothing to install.
COPY package.json server.mjs ./
COPY plugin ./plugin

# Generated files (secret, plugin copy, exports) go to a writable folder inside the container.
ENV LOCALFIG_HOME=/tmp/localfig

USER node

CMD ["node", "server.mjs"]
