# 部署

## Docker 部署

镜像基于 `node:22-alpine`,并安装 Chromium 供智云页面完成瑞数校验。账号数据通过宿主机 `./data` 目录持久化,`.env` 通过 `env_file` 注入容器。

```bash
cp .env.example .env          # 先准备 .env 并修改 ADMIN_PASSWORD
docker compose up -d --build  # 构建并后台启动
# 访问 http://localhost:4000

docker compose logs -f        # 查看日志
docker compose down           # 停止并移除容器(./data 账号数据保留)
```

说明:
- 改 `.env` 的 `PORT` 后,`docker-compose.yml` 的端口映射会自动跟随(两端均读 `${PORT}`);生效需重建:`docker compose up -d`。
- 账号数据落盘在宿主机 `./data/accounts.json`,容器删除/重建不丢失;彻底清空请删除 `./data` 目录。
- `.env` 不会被打入镜像(`.dockerignore` 已排除),密码只存在于运行时环境。

## 一键脚本 deploy.sh

封装了上述常用操作,免去记忆 docker compose 参数:

```bash
./deploy.sh start     # 构建并启动
./deploy.sh stop      # 停止并移除容器(./data 数据保留)
./deploy.sh restart   # 重启(不重新构建)
./deploy.sh status    # 查看状态
./deploy.sh logs      # 查看日志(Ctrl+C 退出不停止服务)
./deploy.sh update    # git pull + 重新构建启动
```

## 本地开发

```bash
npm install
npm start             # 默认 http://localhost:4000
npm test              # 单元测试(node --test,test/ 目录本地跑,不入库)
```

要求 Node ≥ 22.12;智云平台抓取需要本机有 Chrome/Chromium(可用 `TELECOMJS_CHROME_PATH` 指定路径)。
