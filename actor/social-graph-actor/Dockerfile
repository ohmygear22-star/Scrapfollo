FROM node:22-slim
WORKDIR /home/myuser
COPY bundle/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY bundle/main.cjs ./main.cjs
CMD ["node", "main.cjs"]
