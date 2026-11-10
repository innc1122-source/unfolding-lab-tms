# 公开试用站（Render / Railway）。正式部署见 docs/GO-LIVE-CHECKLIST.md，不用这个文件。
# 前端已预先构建在 public/dist/，这里不需要装依赖、也不需要构建。
FROM node:24-slim
WORKDIR /app
COPY . .
# 签到「当天」等按服务器本地日期算，必须是北京时间（托管平台默认 UTC，会差 8 小时）
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    NODE_NO_WARNINGS=1
# 打包时先造好演示库（约 30 秒）：免费托管休眠后每次唤醒都是冷启动，启动时直接复制，不用再等
RUN node scripts/demo-start.js --build-seed
CMD ["node", "scripts/demo-start.js"]
