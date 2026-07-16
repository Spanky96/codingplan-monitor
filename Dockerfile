# Node 版本对齐开发环境 v22,alpine 体积更小
FROM node:22-alpine

WORKDIR /app

# 智云受瑞数保护，需由真实 Chromium 环境执行页面脚本并生成逐请求签名
RUN apk add --no-cache chromium xvfb-run
ENV TELECOMJS_CHROME_PATH=/usr/bin/chromium

# 先复制依赖描述并安装,利用 Docker 层缓存:仅 package*.json 变化才会重装
COPY package*.json ./
RUN npm ci --omit=dev

# 再复制源码(.dockerignore 已排除 node_modules / .env / accounts.json / data 等)
COPY . .

# 应用监听端口(对应 .env 的 PORT,默认 4000)
EXPOSE 4000

CMD ["xvfb-run", "-a", "node", "server.js"]
