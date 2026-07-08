#!/usr/bin/env bash
# deploy.sh — codingplan-monitor 服务管理脚本
#
# 用法:
#   ./deploy.sh start     启动服务(构建镜像并后台运行)
#   ./deploy.sh stop      停止并移除容器(./data 账号数据保留)
#   ./deploy.sh restart   重启容器(不重新构建)
#   ./deploy.sh status    查看运行状态
#   ./deploy.sh logs      查看日志(Ctrl+C 退出,不停止服务)
#   ./deploy.sh update    拉取最新代码并重新构建启动
#   ./deploy.sh help      显示帮助
#
# 所有操作基于 docker compose,请先安装 Docker 并完成 cp .env.example .env。

set -euo pipefail

# ---------- 基础环境 ----------

# 切换到脚本所在目录,保证从任意位置调用都能找到 docker-compose.yml / .env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- 颜色输出(非交互终端自动关闭,避免日志里出现转义码) ----------

if [[ -t 1 ]]; then
  COLOR_RESET=$'\033[0m'
  COLOR_INFO=$'\033[1;34m'    # 蓝
  COLOR_OK=$'\033[1;32m'      # 绿
  COLOR_WARN=$'\033[1;33m'    # 黄
  COLOR_ERROR=$'\033[1;31m'   # 红
else
  COLOR_RESET=''
  COLOR_INFO=''
  COLOR_OK=''
  COLOR_WARN=''
  COLOR_ERROR=''
fi

info()    { printf '%s[INFO]%s  %s\n'    "$COLOR_INFO"  "$COLOR_RESET" "$*"; }
ok()      { printf '%s[ OK ]%s  %s\n'    "$COLOR_OK"    "$COLOR_RESET" "$*"; }
warn()    { printf '%s[WARN]%s  %s\n'    "$COLOR_WARN"  "$COLOR_RESET" "$*" >&2; }
die()     { printf '%s[FAIL]%s  %s\n'    "$COLOR_ERROR" "$COLOR_RESET" "$*" >&2; exit 1; }

# ---------- 前置检查 ----------

# 优先用 docker compose(插件版),回退到 docker-compose(独立版)
detect_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    die "未检测到 docker compose,请先安装 Docker: https://docs.docker.com/get-docker/"
  fi
}

# 检查 .env 是否就绪(没有则给出明确指引)
ensure_env_file() {
  if [[ ! -f .env ]]; then
    warn "未找到 .env 配置文件"
    if [[ -f .env.example ]]; then
      die "请先执行: cp .env.example .env 并修改 ADMIN_PASSWORD 后再启动"
    else
      die "请先创建 .env(可参考 README)后再启动"
    fi
  fi
}

# ---------- 子命令实现 ----------

cmd_start() {
  info "构建镜像并启动服务..."
  "${COMPOSE_CMD[@]}" up -d --build
  ok "服务已启动"
  show_endpoints
}

cmd_stop() {
  info "停止并移除容器(./data 账号数据保留)..."
  "${COMPOSE_CMD[@]}" down
  ok "服务已停止"
}

cmd_restart() {
  info "重启容器..."
  "${COMPOSE_CMD[@]}" restart
  ok "服务已重启"
  show_endpoints
}

cmd_status() {
  info "当前状态:"
  "${COMPOSE_CMD[@]}" ps
}

cmd_logs() {
  info "实时日志(Ctrl+C 退出,不会停止服务):"
  "${COMPOSE_CMD[@]}" logs -f --tail=200
}

cmd_update() {
  if [[ -d .git ]]; then
    info "拉取最新代码..."
    git pull --ff-only
  else
    warn "当前目录不是 git 仓库,跳过 git pull"
  fi
  info "重新构建并启动服务..."
  "${COMPOSE_CMD[@]}" up -d --build
  ok "更新完成"
  show_endpoints
}

# 从 .env 读取 PORT,用于打印访问地址(读取失败则回退默认 4000)
show_endpoints() {
  local port
  port="$(grep -E '^PORT=' .env 2>/dev/null | head -n1 | cut -d= -f2 | tr -d '[:space:]' || true)"
  port="${port:-4000}"
  echo
  ok "本机访问:  http://localhost:${port}"
}

# ---------- 帮助 ----------

show_help() {
  cat <<EOF
codingplan-monitor 服务管理脚本

用法:
  ./deploy.sh <command>

可用命令:
  start      启动服务(docker compose up -d --build)
  stop       停止并移除容器,./data 账号数据保留(docker compose down)
  restart    重启容器,不重新构建(docker compose restart)
  status     查看运行状态(docker compose ps)
  logs       查看实时日志,Ctrl+C 退出不会停止服务(docker compose logs -f)
  update     拉取最新代码并重新构建启动(git pull + up -d --build)
  help       显示本帮助

首次使用前请确保:
  1. 已安装 Docker
  2. 已执行 cp .env.example .env 并修改 ADMIN_PASSWORD
EOF
}

# ---------- 入口 ----------

main() {
  local cmd="${1:-help}"

  case "$cmd" in
    start)            detect_compose_cmd; ensure_env_file; cmd_start ;;
    stop)             detect_compose_cmd; cmd_stop ;;
    restart)          detect_compose_cmd; cmd_restart ;;
    status|st)        detect_compose_cmd; cmd_status ;;
    logs|log)         detect_compose_cmd; cmd_logs ;;
    update|upgrade)   detect_compose_cmd; ensure_env_file; cmd_update ;;
    help|-h|--help)   show_help ;;
    *)
      warn "未知命令: $cmd"
      echo
      show_help
      exit 1
      ;;
  esac
}

main "$@"
