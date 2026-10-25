FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --workspaces=false && npm cache clean --force
COPY src ./src
COPY gateway ./gateway
USER node
EXPOSE 8080
CMD ["node", "gateway/payments.ts"]
