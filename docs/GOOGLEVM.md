# Google VM 部署与项目日志

文财演示地址：`https://wencai.35-247-141-61.sslip.io`。服务器目录：`/home/Adverb1al/wencai_agent_ref`。

## 运行方式

- Docker 镜像使用 Node.js 22，`pnpm build` 后由 `scripts/serve.mjs` 提供 SSR、静态资源和流式 Agent 响应，不运行 Vite 开发服务器。
- `compose.production.yml` 管理 `web`、`worker`、`demo-sms` 三个项目服务，自动重启、日志轮转；仅网页容器加入已有 Caddy 网关网络。
- Caddy 为上述独立域名申请并自动续期 HTTPS 证书，转发到 `wencai-web:3000`。安全验证使用同源独立 iframe，因此响应头须允许 `SAMEORIGIN`。
- 数据保存在服务器 `data/bank.db`。首次部署使用本地 SQLite 一致性快照和原签名密钥，以保留银行卡加密数据、余额和账单。后续部署不覆盖数据库，也不重新播种。
- `.env.production` 只保存在服务器，权限 600，不进入 Git 或 Docker 镜像；必须配置原 `CONFIRM_SECRET`、模型密钥和公网 `PUBLIC_BASE_URL`。

## 演示模式

显式设置 `AUTH_DEMO_MODE=true`。生产构建不会自动启用演示模式。

当前没有真实短信网关，`SMS_DELIVERY_URL=http://demo-sms:3100/send` 指向私有演示短信适配器。适配器不发布主机端口，必须显式开启演示模式并携带独立 `SMS_DELIVERY_TOKEN`；演示验证码仅显示在项目日志，不发送真实短信。真实业务部署应替换为真实短信网关并关闭演示模式。

公网后台开启访问凭据校验。进入 `/admin` 后，点击“后台访问验证”输入部署时单独保存的凭据；没有凭据的请求不能读取后台数据。凭据不写入文档。

## 本机查看实时项目日志

双击根目录 `open-googlevm-logs.bat`，同时查看网页请求、Agent 运行错误、自动任务和演示验证码。

关闭日志窗口或按 Ctrl+C 仅停止查看日志，不停止服务器项目。

服务器命令：

```sh
cd /home/Adverb1al/wencai_agent_ref
docker compose --env-file .env.production -f compose.production.yml logs -f --tail=100 --timestamps web worker demo-sms
```

## 更新与检查

更新前对 SQLite 使用一致性备份。同步源码时排除 `.env.production`、`data/` 和 `backups/`。

```sh
docker compose --env-file .env.production -f compose.production.yml build web
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml ps
curl -fsS https://wencai.35-247-141-61.sslip.io/api/health
```

`APP_REVISION` 记录部署提交。新数据库才需要 `drizzle-kit push` 和播种；已有数据库不要执行 `db:reset` 或播种脚本。
