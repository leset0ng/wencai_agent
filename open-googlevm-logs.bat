@echo off
chcp 65001 >nul
title 文财 Google VM 项目实时日志
echo 文财项目实时日志：网页服务、后台任务、演示验证码
echo 关闭窗口或按 Ctrl+C 只停止查看日志，不停止云端服务。
ssh -t -o ServerAliveInterval=30 google-vm "cd /home/Adverb1al/wencai_agent_ref && docker compose --env-file .env.production -f compose.production.yml logs --follow --tail=100 --timestamps web worker demo-sms"
pause
