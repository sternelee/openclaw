# Webhook Gateway Integration - Implementation Summary

## 问题 (Question)

openclaw 如何开发一个新的 webhook gateway 与其集成？比如采用 cloudflare websocket 实现 webhook 服务

## 解决方案 (Solution)

本PR提供了完整的webhook gateway集成指南和示例代码，包括：

### 创建的文档 (Created Documentation)

1. **[webhook-integration.md](./docs/gateway/webhook-integration.md)** (891行)
   - 完整的webhook gateway实现指南
   - 架构概述和关键概念
   - 分步实现说明（Webhook Handler → Monitor → Gateway Adapter → Registry）
   - 安全最佳实践（签名验证、错误处理、优雅关闭）
   - 测试和故障排除指南

2. **[webhook-example-cloudflare.md](./docs/gateway/webhook-example-cloudflare.md)** (834行)
   - 生产就绪的Cloudflare Workers实现
   - 完整的Worker代码（签名验证、速率限制、错误处理）
   - OpenClaw Gateway集成代码
   - 部署指南和监控设置
   - WebSocket支持和高级功能

3. **[webhook-quick-reference.md](./docs/gateway/webhook-quick-reference.md)** (377行)
   - 快速参考和代码模板
   - 常见签名验证模式（HMAC-SHA256、Secret Token等）
   - 测试命令和故障排除
   - 性能优化建议

4. **[webhook-example-implementation.ts](./docs/gateway/webhook-example-implementation.ts)** (286行)
   - 可直接复制使用的TypeScript实现模板
   - 包含完整的签名验证、事件处理和错误处理
   - Gateway Adapter注册示例

5. **[webhook-README.md](./docs/gateway/webhook-README.md)** (224行)
   - Webhook文档导航和快速开始指南
   - 安全和测试检查清单
   - 常见平台签名方法对照表
   - 故障排除指南

### 核心实现模式 (Core Implementation Patterns)

#### 1. Webhook Handler（签名验证 + 即时响应）

```typescript
import { registerPluginHttpRoute } from "../plugins/http-registry.js";

const unregisterHttp = registerPluginHttpRoute({
  path: "/your-channel/webhook",
  pluginId: "your-channel",
  handler: async (req, res) => {
    // 1. 读取原始请求体
    const rawBody = await readRequestBody(req);
    const signature = req.headers["x-signature"];
    
    // 2. 验证签名（关键安全步骤）
    if (!validateSignature(rawBody, signature, secret)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }
    
    // 3. 立即返回200（避免平台超时）
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok" }));
    
    // 4. 异步处理事件
    const event = JSON.parse(rawBody);
    await processEvent(event).catch(console.error);
  },
});
```

#### 2. 签名验证（HMAC-SHA256）

```typescript
import crypto from "node:crypto";

function validateSignature(body: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expectedSignature = hmac.digest("hex");
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

#### 3. Gateway Adapter注册

```typescript
export const yourChannelPlugin: ChannelPlugin = {
  id: "your-channel",
  name: "Your Channel",
  
  gateway: {
    startAccount: async (ctx) => {
      return await monitorYourChannelProvider({
        apiKey: ctx.account.credentials.apiKey,
        secret: ctx.account.credentials.secret,
        accountId: ctx.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
```

### Cloudflare Workers示例 (Cloudflare Workers Example)

完整的serverless webhook实现：

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 健康检查
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Webhook端点
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      const signature = request.headers.get("X-Signature");

      // 验证签名
      if (!await validateSignature(body, signature, env.WEBHOOK_SECRET)) {
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401 }
        );
      }

      // 立即响应
      const response = new Response(
        JSON.stringify({ status: "ok" }),
        { status: 200 }
      );

      // 异步转发到OpenClaw Gateway
      ctx.waitUntil(
        forwardToGateway(JSON.parse(body), env.GATEWAY_URL, env.GATEWAY_TOKEN)
      );

      return response;
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

### 文件结构 (File Structure)

实现新channel时的推荐结构：

```
src/
├── your-channel/
│   ├── monitor.ts          # Gateway monitor（HTTP路由注册）
│   ├── bot.ts              # 消息处理逻辑
│   ├── send.ts             # 出站消息发送
│   ├── signature.ts        # 签名验证
│   └── types.ts            # TypeScript类型
└── channels/
    └── plugins/
        └── your-channel.ts # Channel plugin注册
```

### 安全检查清单 (Security Checklist)

部署前必须完成：

- ✅ 实现并测试签名验证
- ✅ 使用时序安全比较（`crypto.timingSafeEqual`）
- ✅ 仅使用HTTPS（生产环境禁用HTTP）
- ✅ 配置速率限制
- ✅ 错误消息不泄露敏感信息
- ✅ 记录安全事件
- ✅ 安全存储密钥（不要硬编码）

### 测试流程 (Testing Workflow)

1. **本地开发**
   ```bash
   # 启动gateway
   openclaw gateway run --bind loopback --port 18789
   
   # 使用ngrok暴露本地端点
   ngrok http 18789
   ```

2. **测试webhook**
   ```bash
   # 生成签名
   BODY='{"type":"message","text":"test"}'
   SECRET="your-secret"
   SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
   
   # 发送webhook
   curl -X POST http://localhost:18789/your-channel/webhook \
     -H "Content-Type: application/json" \
     -H "X-Signature: $SIGNATURE" \
     -d "$BODY"
   ```

3. **查看日志**
   ```bash
   tail -f ~/.openclaw/gateway.log
   openclaw channels status --deep
   ```

### 配置示例 (Configuration Example)

```yaml
channels:
  your-channel:
    accounts:
      - id: main
        enabled: true
        credentials:
          apiKey: "your-api-key"
          secret: "your-webhook-secret"
        webhookPath: "/your-channel/webhook"
        publicUrl: "https://your-domain.com/your-channel/webhook"
```

### 参考实现 (Reference Implementations)

可以参考现有的webhook实现：

- **Telegram**: `src/telegram/webhook.ts` - HTTP webhook with grammy framework
- **LINE**: `src/line/monitor.ts` - Plugin registry pattern with signature validation
- **Gateway HTTP**: `src/gateway/server-http.ts` - Core HTTP server setup

### 常见平台签名方法 (Common Platform Signature Methods)

| 平台 | 方法 | Header |
|------|------|--------|
| Telegram | HMAC-SHA256 or secret token | `X-Telegram-Bot-Api-Secret-Token` |
| LINE | HMAC-SHA256 base64 | `X-Line-Signature` |
| GitHub | HMAC-SHA256 hex (prefixed) | `X-Hub-Signature-256` |
| Slack | HMAC-SHA256 hex (prefixed) | `X-Slack-Signature` |
| Discord | Ed25519 signature | `X-Signature-Ed25519` |

## 关键要点 (Key Takeaways)

1. **签名验证是必须的** - 在处理任何webhook事件之前，必须验证签名以确保请求来自可信来源

2. **立即响应** - Webhook handler必须立即返回200状态码，然后异步处理事件，避免平台超时

3. **使用Plugin HTTP Registry** - 使用OpenClaw的`registerPluginHttpRoute`来注册HTTP路由，支持多账户和优雅关闭

4. **优雅关闭** - 监听`abortSignal`并正确清理资源

5. **错误处理** - 捕获并记录所有错误，但不要让异常导致服务崩溃

6. **Cloudflare Workers优势**:
   - 全球分布，低延迟
   - 高可用性
   - Serverless，无需管理基础设施
   - 成本效益（免费层每天10万请求）

## 下一步 (Next Steps)

1. 阅读完整文档：[docs/gateway/webhook-integration.md](./docs/gateway/webhook-integration.md)
2. 复制示例代码：[docs/gateway/webhook-example-implementation.ts](./docs/gateway/webhook-example-implementation.ts)
3. 参考Cloudflare示例：[docs/gateway/webhook-example-cloudflare.md](./docs/gateway/webhook-example-cloudflare.md)
4. 查看快速参考：[docs/gateway/webhook-quick-reference.md](./docs/gateway/webhook-quick-reference.md)

## 文档更新 (Documentation Updates)

- 更新了`docs/gateway/index.md`，添加了webhook集成章节
- 更新了`CHANGELOG.md`，记录了文档改进

## PR状态 (PR Status)

- ✅ 完整的实现指南
- ✅ 生产就绪示例（Cloudflare Workers）
- ✅ 代码模板和快速参考
- ✅ 安全最佳实践
- ✅ 测试和故障排除指南
- ✅ CHANGELOG更新

所有文档已提交到分支：`copilot/add-webhook-gateway-integration`

## 总结 (Summary)

本PR提供了完整的webhook gateway集成解决方案，包括：
- 详细的实现指南（2600+行文档）
- 生产级Cloudflare Workers示例
- 可直接使用的代码模板
- 安全最佳实践和测试指南

开发者现在可以使用这些文档和示例快速实现自己的webhook gateway集成，无论是使用Cloudflare Workers还是其他平台。所有关键模式（签名验证、即时响应、优雅关闭）都有详细说明和代码示例。
