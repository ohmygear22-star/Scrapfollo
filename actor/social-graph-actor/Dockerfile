FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /home/myuser
COPY bundle/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY bundle/main.cjs ./main.cjs
CMD ["node", "main.cjs"]
