#!/bin/sh
# KRL Cloud 노드 에이전트 설치 (Linux / macOS / Android-Termux)
#   curl -fsSL __SERVER__/install.sh | sh
# 실행하면 화면에 연결 코드가 표시됩니다. 대시보드의 "내 PC 연결"에 입력하면 이 PC가 자동으로 호스팅에 참여하고,
# 부팅/로그인 시 자동 시작됩니다. (토큰이 있으면: ... | sh -s -- --token krln_xxx)
#   제거: curl -fsSL __SERVER__/install.sh | sh -s -- uninstall
set -e
SERVER="__SERVER__"
DIR="$HOME/.krl-agent"
IS_TERMUX=0; { [ -n "$TERMUX_VERSION" ] || [ -d /data/data/com.termux ]; } && IS_TERMUX=1

if ! command -v node >/dev/null 2>&1; then
  if [ "$IS_TERMUX" = 1 ]; then echo "Node.js 설치 중 (Termux)…"; pkg install -y nodejs git
  else echo "Node.js 20+ 가 필요합니다. https://nodejs.org 에서 설치하거나 패키지 매니저로 설치하세요 (brew install node / apt install nodejs)."; exit 1; fi
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20 이상이 필요합니다."; exit 1; }

mkdir -p "$DIR"
curl -fsSL "$SERVER/agent/agent.js" -o "$DIR/agent.js"
if [ "$1" = "uninstall" ]; then exec node "$DIR/agent.js" uninstall; fi
exec node "$DIR/agent.js" install --server "$SERVER" "$@"
