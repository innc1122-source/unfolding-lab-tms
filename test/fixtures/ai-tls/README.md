测试专用证书（`test/ai-provider.test.js` 的证书校验用例）。

- `ca.pem`：测试 CA（私钥已在生成后删除，不能再签发任何证书）。
- `localhost.pem` / `localhost.key`：由测试 CA 签发，SAN 为 `localhost`、`127.0.0.1`。
- `wrong.pem` / `wrong.key`：由测试 CA 签发，SAN 为 `wrong.example`（主机名不符的用例）。

这些私钥只用于本机回环地址上的假服务商，与任何真实系统无关。有效期 20 年（2026-09 生成）。
