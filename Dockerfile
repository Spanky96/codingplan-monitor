# Node 版本对齐开发环境 v22,alpine 体积更小
FROM node:22-alpine

WORKDIR /app

# 智云依赖开关:Chromium 仅智云(token.telecomjs.com)抓取需要——
# 受瑞数保护,需真实 Chromium 执行页面脚本并生成逐请求签名。
# 不部署智云账号时设 INSTALL_CHROMIUM=0(compose 从 .env 读),跳过 ~200MB 依赖,
# 构建从 20+ 分钟降到 1-2 分钟;代码侧 findChrome() 找不到时仅智云抓取报错,其余平台不受影响
ARG INSTALL_CHROMIUM=1

# alpine 官方 CDN 国内不通:换阿里云镜像源再装包,否则 apk 会长时间挂起。
# tini 始终安装(用作 PID 1);chromium/xvfb-run 仅在 INSTALL_CHROMIUM=1 时安装
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
    && apk add --no-cache tini \
    && if [ "$INSTALL_CHROMIUM" = "1" ]; then apk add --no-cache chromium xvfb-run; fi

# 先复制依赖描述并安装,利用 Docker 层缓存:仅 package*.json 变化才会重装
COPY package*.json ./
# 国内构建默认走 npmmirror,可用 --build-arg NPM_REGISTRY=... 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm_config_registry=${NPM_REGISTRY} npm ci --omit=dev

# 再复制源码(.dockerignore 已排除 node_modules / .env / accounts.json / data 等)
COPY . .

# 应用监听端口(对应 .env 的 PORT,默认 4000)
EXPOSE 4000

# 安装了 xvfb-run(智云依赖)时经 Xvfb 启动,否则直接跑 node;
# tini 作为 PID 1,避免 Alpine xvfb-run 作为 PID 1 时卡在等待 Xvfb 的 SIGUSR1
CMD ["/bin/sh", "-c", "if command -v xvfb-run >/dev/null 2>&1; then exec /sbin/tini -- xvfb-run -a node src/server.js; else exec /sbin/tini -- node src/server.js; fi"]
