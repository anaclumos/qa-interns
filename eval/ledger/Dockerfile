FROM oven/bun:1
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
