# Webhook Gateway Quick Reference

Quick reference for implementing webhook gateways in OpenClaw. For detailed documentation, see [webhook-integration.md](./webhook-integration.md).

## Minimal Implementation Checklist

- [ ] Create webhook handler with signature validation
- [ ] Create monitor function using plugin HTTP registry
- [ ] Register gateway adapter in channel plugin
- [ ] Add channel to registry catalog
- [ ] Test signature validation
- [ ] Test with local ngrok tunnel
- [ ] Deploy to production

## Essential Patterns

### 1. Signature Validation (HMAC-SHA256)

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

### 2. HTTP Webhook Handler (Plugin Registry)

```typescript
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";

const normalizedPath = normalizePluginHttpPath(webhookPath, "/my-channel/webhook");

const unregisterHttp = registerPluginHttpRoute({
  path: normalizedPath,
  pluginId: "my-channel",
  accountId: resolvedAccountId,
  log: (msg) => logVerbose(msg),
  handler: async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    const rawBody = await readRequestBody(req);
    const signature = req.headers["x-signature"];

    // Validate signature
    if (!validateSignature(rawBody, signature, secret)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    // Parse event
    const event = JSON.parse(rawBody);

    // Respond immediately (CRITICAL)
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok" }));

    // Process asynchronously
    await bot.handleEvent(event).catch((err) => {
      runtime.error?.(`event processing failed: ${String(err)}`);
    });
  },
});
```

### 3. Gateway Adapter Registration

```typescript
import type { ChannelPlugin } from "./types.plugin.js";

export const myChannelPlugin: ChannelPlugin = {
  id: "my-channel",
  name: "My Channel",
  
  gateway: {
    startAccount: async (ctx) => {
      const { apiKey, secret } = ctx.account.credentials;
      
      const monitor = await monitorMyChannelProvider({
        apiKey,
        secret,
        accountId: ctx.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: ctx.account.webhookPath,
      });

      return monitor;
    },

    stopAccount: async (ctx) => {
      ctx.runtime.log?.(`stopping account ${ctx.accountId}`);
    },
  },
};
```

### 4. Graceful Shutdown

```typescript
const stopHandler = () => {
  unregisterHttp();
  server?.close();
};

abortSignal?.addEventListener("abort", stopHandler);

return {
  stop: () => {
    stopHandler();
    abortSignal?.removeEventListener("abort", stopHandler);
  },
};
```

### 5. Read Request Body Helper

```typescript
async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

## File Structure

```
src/
├── my-channel/
│   ├── monitor.ts          # Gateway monitor (HTTP route registration)
│   ├── bot.ts              # Message processing logic
│   ├── send.ts             # Outbound message delivery
│   ├── signature.ts        # Signature validation
│   └── types.ts            # TypeScript types
└── channels/
    └── plugins/
        └── my-channel.ts   # Channel plugin definition
```

## Common Signature Patterns

### HMAC-SHA256 (LINE, Custom)

```typescript
import crypto from "node:crypto";

function validateHmacSha256(body: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("base64"); // or "hex"
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### SHA256 with Prefix (GitHub)

```typescript
function validateGitHubSignature(body: string, signature: string, secret: string): boolean {
  // signature format: "sha256=<hex>"
  const sig = signature.replace("sha256=", "");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

### Secret Token (Telegram)

```typescript
function validateSecretToken(providedToken: string, expectedToken: string): boolean {
  return crypto.timingSafeEqual(
    Buffer.from(providedToken),
    Buffer.from(expectedToken)
  );
}
```

## Testing Commands

### Local Development

```bash
# Start gateway
openclaw gateway run --bind loopback --port 18789

# In another terminal, expose with ngrok
ngrok http 18789

# Update platform webhook to ngrok URL
https://your-ngrok-url.ngrok.io/your-channel/webhook
```

### Test Webhook

```bash
# Generate signature
BODY='{"type":"message","text":"test"}'
SECRET="your-secret"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')

# Send webhook
curl -X POST http://localhost:18789/your-channel/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -d "$BODY"
```

### View Logs

```bash
# OpenClaw gateway logs
tail -f ~/.openclaw/gateway.log

# Or check status
openclaw channels status --deep
```

## Configuration Example

```yaml
channels:
  my-channel:
    accounts:
      - id: main
        enabled: true
        credentials:
          apiKey: "your-api-key"
          secret: "your-webhook-secret"
        webhookPath: "/my-channel/webhook"
        publicUrl: "https://your-domain.com/my-channel/webhook"
```

## Common Issues & Solutions

### Issue: Signature validation always fails

**Solutions:**
- Verify you're reading raw body (before JSON parsing)
- Check signature format (hex, base64, prefixed?)
- Ensure UTF-8 encoding
- Log both received and expected signatures

### Issue: Platform times out waiting for response

**Solutions:**
- Respond with 200 immediately before processing
- Process events asynchronously
- Don't await event processing in HTTP handler

### Issue: Events not reaching OpenClaw

**Solutions:**
- Check HTTP route is registered: `openclaw channels status`
- Verify webhook path matches configuration
- Test endpoint directly with curl
- Check gateway is running: `ps aux | grep openclaw`

### Issue: Multiple accounts causing conflicts

**Solutions:**
- Use unique webhook paths per account
- Include `accountId` in route registration
- Check for path collisions in logs

## Security Checklist

- [ ] **Always validate signatures** before processing
- [ ] **Use timing-safe comparison** for signature validation
- [ ] **Return 200 immediately** to prevent timeout attacks
- [ ] **Log security events** (invalid signatures, rate limits)
- [ ] **Rate limit** webhook endpoints
- [ ] **Use HTTPS only** in production
- [ ] **Validate content-type** header
- [ ] **Sanitize error messages** (don't leak secrets)

## Performance Tips

- ✅ Respond with 200 immediately (< 100ms)
- ✅ Process events asynchronously
- ✅ Use streaming for large payloads
- ✅ Implement request deduplication if needed
- ✅ Add timeout to external API calls
- ✅ Use connection pooling for outbound requests

## Reference Implementations

| Channel | File | Type | Notes |
|---------|------|------|-------|
| Telegram | `src/telegram/webhook.ts` | HTTP + grammy | Secret token validation |
| LINE | `src/line/monitor.ts` | HTTP + plugin registry | HMAC-SHA256 signature |
| Gateway | `src/gateway/server-http.ts` | HTTP server | Core HTTP setup |

## Further Reading

- [Webhook Integration Guide](./webhook-integration.md) - Detailed implementation guide
- [Cloudflare WebSocket Example](./webhook-example-cloudflare.md) - Production example
- [Channel Plugin Development](../channels/plugins) - Plugin system overview
- [Security Guidelines](../../SECURITY.md) - Security best practices

## Quick Start Template

Copy this template to get started:

```typescript
// src/my-channel/monitor.ts
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";

export async function monitorMyChannelProvider(opts: {
  secret: string;
  accountId: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
}) {
  const path = normalizePluginHttpPath(opts.webhookPath, "/my-channel/webhook");
  
  const unregister = registerPluginHttpRoute({
    path,
    pluginId: "my-channel",
    accountId: opts.accountId,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }

      const body = await readRequestBody(req);
      const sig = req.headers["x-signature"] as string;
      
      if (!validateSignature(body, sig, opts.secret)) {
        res.statusCode = 401;
        res.end();
        return;
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok" }));

      const event = JSON.parse(body);
      await processEvent(event).catch(console.error);
    },
  });

  opts.abortSignal?.addEventListener("abort", unregister);

  return { stop: unregister };
}
```

---

**Remember:** The most critical aspects are:
1. **Validate signatures** (security)
2. **Return 200 immediately** (reliability)
3. **Handle errors gracefully** (stability)
