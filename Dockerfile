# Node 版本对齐开发环境 v22,alpine 体积更小
FROM node:22-alpine

WORKDIR /app

# 智云受瑞数保护，需由真实 Chromium 环境执行页面脚本并生成逐请求签名。
# tini 作为 PID 1，避免 Alpine xvfb-run 作为 PID 1 时卡在等待 Xvfb 的 SIGUSR1。
# alpine 官方 CDN 国内不通：换阿里云镜像源再装包，否则 apk 会长时间挂起。
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
    && apk add --no-cache chromium xvfb-run tini
ENV TELECOMJS_CHROME_PATH=/usr/bin/chromium

# 先复制依赖描述并安装,利用 Docker 层缓存:仅 package*.json 变化才会重装
COPY package*.json ./
# 国内构建默认走 npmmirror,可用 --build-arg NPM_REGISTRY=... 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm_config_registry=${NPM_REGISTRY} npm ci --omit=dev

# 再复制源码(.dockerignore 已排除 node_modules / .env / accounts.json / data 等)
COPY . .

# 应用监听端口(对应 .env 的 PORT,默认 4000)
EXPOSE 4000

CMD ["/sbin/tini", "--", "xvfb-run", "-a", "node", "server.js"]
