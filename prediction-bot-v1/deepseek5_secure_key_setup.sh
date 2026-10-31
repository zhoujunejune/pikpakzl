#!/usr/bin/env bash
# Secure, interactive, one-time DeepSeek API credential setup for the already installed
# zl-prediction-deepseek5.service on Alibaba. Do not run from CI or a non-TTY.
# No credential is hardcoded, echoed, passed as a command argument or printed to logs.
set -Eeuo pipefail
set +x
umask 077

if [ "$(id -u)" -ne 0 ]; then
  printf '请在阿里云终端使用 sudo bash 执行此脚本。\n' >&2
  exit 1
fi
if ! [ -r /dev/tty ]; then
  printf '需要交互式终端，禁止通过 GitHub Actions 或无终端脚本输入密钥。\n' >&2
  exit 1
fi

service=zl-prediction-deepseek5.service
env_file=/etc/zl-prediction/deepseek5.env
if ! [ -f "$env_file" ] || [ -L "$env_file" ]; then
  printf 'DeepSeek 服务环境文件不存在或存在符号链接，已安全停止。\n' >&2
  exit 2
fi
if [ "$(systemctl is-active "$service")" != active ]; then
  printf 'DeepSeek 服务尚未正常运行，已安全停止。\n' >&2
  exit 3
fi

printf '请输入新建的 DeepSeek API Key（输入时不会显示），然后回车：' > /dev/tty
IFS= read -r -s key < /dev/tty
printf '\n' > /dev/tty

if [[ ! "$key" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]]; then
  unset key
  printf '密钥格式不正确，未修改服务器。\n' >&2
  exit 4
fi

oldfile=$(mktemp /etc/zl-prediction/.deepseek5-old.XXXXXXXX)
newfile=$(mktemp /etc/zl-prediction/.deepseek5-new.XXXXXXXX)
chmod 600 "$oldfile" "$newfile"
copied=0
success=0
cleanup(){
  if [ "$success" != 1 ] && [ "$copied" = 1 ] && [ -f "$oldfile" ]; then
    cp "$oldfile" "$env_file" && chmod 600 "$env_file" || :
    systemctl restart "$service" >/dev/null 2>&1 || :
  fi
  unset key
  rm -f "$oldfile" "$newfile"
}
trap cleanup EXIT
cp "$env_file" "$oldfile"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in DEEPSEEK_API_KEY=*) continue ;; esac
  printf '%s\n' "$line" >> "$newfile"
done < "$oldfile"
printf 'DEEPSEEK_API_KEY=%s\n' "$key" >> "$newfile"
unset key

chown root:root "$newfile"
chmod 600 "$newfile"
mv -f "$newfile" "$env_file"
copied=1
systemctl restart "$service" >/dev/null
verified=false
for _ in $(seq 1 18); do
  if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("model")=="DEEPSEEK_5M_V1" and d.get("configured") is True and d.get("realOrderEnabled") is False and d.get("tradeIntegration") is False' 2>/dev/null; then
    verified=true
    break
  fi
  sleep 1
done
if [ "$verified" != true ]; then
  printf '配置验证失败，正在恢复之前的环境文件。\n' >&2
  exit 5
fi
success=1
printf 'DEEPSEEK_SECRET_CONFIGURED=true\n'
printf 'DEEPSEEK_SIGNAL_SERVICE_ACTIVE=true\n'
printf 'DEEPSEEK_REAL_ORDERS_ENABLED=false\n'
printf '配置成功。下一步需验证真实连续信号和独立的生产路由。\n'
