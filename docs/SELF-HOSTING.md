# Persistent self-hosting / 持久化自部署

The original Dockerfile starts the resettable demo. **Use `Dockerfile.production` for a persistent instance.** This is a single-instance SQLite setup; do not scale multiple containers against the same database volume.

## Local Node.js

Use Node.js 24+, copy `config.json.example` to `config.json`, confirm `production: true`, then run `npm start`. The administrator password is generated on the first startup of a new database and printed in the terminal. Treat this output as sensitive, sign in and change the password.

For persistent storage you can set `LMS_DB_PATH`, `LMS_ATTACH_DIR`, and `LMS_CONFIG_PATH`. See the IT guide for backup and restore procedures.

## Docker Compose example

```sh
cp config.json.example config.json
docker compose up --build
```

The example exposes only `127.0.0.1:8780`, mounts `config.json` read-only and keeps the database and attachments in a named volume. The first administrator password is generated in the container log. Use your own reverse proxy with HTTPS for remote access.

The image includes LibreOffice and ffmpeg for document/media workflows; validate conversions on the target host. Back up the named volume and configuration. Follow `docs/GO-LIVE-CHECKLIST.md` before shared use.

本示例不包含公共域名、证书、邮件或 AI 服务配置，也不提供多租户隔离或多副本部署承诺。
