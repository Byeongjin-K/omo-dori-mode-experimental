#!/bin/bash
# Root installer for the KakaoTalk watcher under its own account (README "KakaoTalk under its own account").
#   install.sh install --relay-user USER --bundle DIR --env-from FILE
#   install.sh login [--phone COUNTRY_CODE] [--account-file FILE]
#                     signs in from FILE (KAKAO_EMAIL=, KAKAO_PASSWORD=), else asks on this terminal
#   install.sh start
# DIR holds node/ (with lib/node_modules/agent-messenger), bun and src/ (the fork's skills/dori-mode); the caller checks
# their hashes. FILE is the relay Dori's dori.env: only its DORI_KAKAO_* tuning lines are copied.
set -euo pipefail
ACCOUNT=dori-kakao
OPT=/opt/dori-kakao
HOME_DIR=/var/lib/dori-kakao
OUT=/var/lib/dori-kakao-out
ETC=/etc/dori-kakao
UNIT=/etc/systemd/system/dori-kakao-watch.service
[ "$(id -u)" = 0 ] || { echo "KAKAO_SYSTEM_REFUSED not root" >&2; exit 2; }

as_watcher() {
  runuser -u "$ACCOUNT" -- env -i HOME="$HOME_DIR" PATH="$OPT/node/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    DORI_ENV_FILE="$ETC/dori.env" DORI_CONFIG="$ETC/config.json" "$@"
}

install_all() {
  local relay="" bundle="" env_from=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --relay-user) relay=$2; shift 2 ;;
      --bundle) bundle=$2; shift 2 ;;
      --env-from) env_from=$2; shift 2 ;;
      *) echo "KAKAO_SYSTEM_REFUSED unknown argument $1" >&2; exit 2 ;;
    esac
  done
  id "$relay" >/dev/null
  [ -x "$bundle/bun" ] && [ -x "$bundle/node/bin/node" ] && [ -d "$bundle/node/lib/node_modules/agent-messenger" ] \
    && [ -f "$bundle/src/setups/discord-aoe/kakao-watch.ts" ] || { echo "KAKAO_SYSTEM_REFUSED incomplete bundle" >&2; exit 2; }
  id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$ACCOUNT"

  rm -rf "$OPT.new"
  mkdir -p "$OPT.new/bin"
  cp -a "$bundle/node" "$OPT.new/node"
  cp -a "$bundle/src" "$OPT.new/src"
  install -m 0755 "$bundle/bun" "$OPT.new/bin/bun"
  install -m 0755 "$bundle/src/setups/discord-aoe/kakao-system/kakao.py" "$OPT.new/bin/kakao"
  install -m 0755 "$bundle/src/setups/discord-aoe/kakao-system/kakao-client.py" "$OPT.new/bin/kakao-client"
  ln -sfn ../lib/node_modules/agent-messenger/dist/src/cli.js "$OPT.new/node/bin/agent-messenger"
  chown -R root:root "$OPT.new"
  chmod -R go-w,a+rX "$OPT.new"
  rm -rf "$OPT.old"
  [ -e "$OPT" ] && mv "$OPT" "$OPT.old"
  mv "$OPT.new" "$OPT"
  rm -rf "$OPT.old"

  install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$HOME_DIR" "$HOME_DIR/state" "$HOME_DIR/.config" "$HOME_DIR/.config/agent-messenger"
  install -d -m 2750 -o "$ACCOUNT" -g "$relay" "$OUT"
  [ -e "$HOME_DIR/state/kakao.lock" ] || install -m 0600 -o "$ACCOUNT" -g "$ACCOUNT" /dev/null "$HOME_DIR/state/kakao.lock"
  [ -e "$OUT/inbox.jsonl" ] || install -m 0640 -o "$ACCOUNT" -g "$relay" /dev/null "$OUT/inbox.jsonl"
  [ -e "$OUT/watch.log" ] || install -m 0640 -o "$ACCOUNT" -g "$relay" /dev/null "$OUT/watch.log"

  install -d -m 0750 -o root -g "$ACCOUNT" "$ETC"
  {
    grep -E '^DORI_KAKAO_[A-Z_]+=' "$env_from" \
      | grep -Ev '^DORI_KAKAO_(STATE_DIR|INBOX|CLI|ACCOUNT_FILE|PROOF_SOCKET|DEVICE_TYPE)=' || true
    echo "DORI_KAKAO_STATE_DIR=$HOME_DIR/state"
    echo "DORI_KAKAO_INBOX=$OUT/inbox.jsonl"
    echo "DORI_KAKAO_CLI=$OPT/node/bin/agent-messenger"
    echo "DORI_KAKAO_PROOF_SOCKET=dori-kakao-proof"
  } > "$ETC/dori.env.new"
  grep -q '^DORI_KAKAO_SELF_ID=.' "$ETC/dori.env.new" || { echo "KAKAO_SYSTEM_REFUSED $env_from has no DORI_KAKAO_SELF_ID" >&2; exit 2; }
  chown root:"$ACCOUNT" "$ETC/dori.env.new"
  chmod 0640 "$ETC/dori.env.new"
  mv "$ETC/dori.env.new" "$ETC/dori.env"

  install -m 0644 "$bundle/src/setups/discord-aoe/kakao-system/dori-kakao-watch.service" "$UNIT"
  printf '%s ALL=(%s) NOPASSWD: %s/bin/kakao\n' "$relay" "$ACCOUNT" "$OPT" > /etc/sudoers.d/dori-kakao.new
  chmod 0440 /etc/sudoers.d/dori-kakao.new
  visudo -cqf /etc/sudoers.d/dori-kakao.new
  mv /etc/sudoers.d/dori-kakao.new /etc/sudoers.d/dori-kakao
  systemctl daemon-reload
  echo "KAKAO_SYSTEM_INSTALLED account=$ACCOUNT relay=$relay"
}

login() {
  local phone=() from=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --phone) phone=(--phone "$2"); shift 2 ;;
      --account-file) from=$2; shift 2 ;;
      *) echo "KAKAO_SYSTEM_REFUSED unknown argument $1" >&2; exit 2 ;;
    esac
  done
  local login password
  LOGIN_FILE=$(runuser -u "$ACCOUNT" -- mktemp "$HOME_DIR/state/login.XXXXXX")
  LOGIN_ENV=$(runuser -u "$ACCOUNT" -- mktemp "$HOME_DIR/state/login-env.XXXXXX")
  trap 'rm -f "$LOGIN_FILE" "$LOGIN_ENV"' EXIT
  if [ -n "$from" ]; then
    grep -E '^(KAKAO_EMAIL|KAKAO_PASSWORD)=' "$from" > "$LOGIN_FILE"
  else
    read -r -p "KakaoTalk login (email or phone): " login
    read -r -s -p "KakaoTalk password (not shown): " password
    echo
    printf 'KAKAO_EMAIL=%s\nKAKAO_PASSWORD=%s\n' "$login" "$password" > "$LOGIN_FILE"
    unset password
  fi
  # kakao-login.ts drops inherited DORI_KAKAO_* and reads them from its env file, so the account file is named there
  { cat "$ETC/dori.env"; echo "DORI_KAKAO_ACCOUNT_FILE=$LOGIN_FILE"; } > "$LOGIN_ENV"
  as_watcher env DORI_ENV_FILE="$LOGIN_ENV" "$OPT/bin/bun" "$OPT/src/setups/discord-aoe/kakao-login.ts" "${phone[@]}"
}

start() {
  # watch.log is append-only: only lines written by this start count, and the unit must still be running
  local from
  from=$(($(stat -c %s "$OUT/watch.log") + 1))
  systemctl enable dori-kakao-watch.service
  systemctl restart dori-kakao-watch.service
  for _ in $(seq 1 60); do
    if tail -c "+$from" "$OUT/watch.log" | grep -q 'KAKAO_PROOF_READY' && systemctl is-active --quiet dori-kakao-watch.service; then
      echo "KAKAO_SYSTEM_STARTED"; return 0
    fi
    sleep 1
  done
  echo "KAKAO_SYSTEM_START_FAIL no KAKAO_PROOF_READY from this start in $OUT/watch.log" >&2
  tail -n 20 "$OUT/watch.log" >&2
  return 1
}

case "${1:-}" in
  install) shift; install_all "$@" ;;
  login) shift; login "$@" ;;
  start) start ;;
  *) echo "usage: install.sh install|login|start" >&2; exit 2 ;;
esac
