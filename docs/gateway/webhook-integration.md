# Webhook Gateway Integration Guide

This guide explains how to develop and integrate a new webhook gateway with OpenClaw. It includes a complete example implementation using Cloudflare WebSocket.

## Overview

OpenClaw's gateway architecture supports both **polling-based** and **webhook-based** channel integrations. This guide focuses on webhook-based integrations, which are ideal for real-time messaging platforms that push updates to your server.

### Key Concepts

- **Gateway Adapter**: Plugin interface that manages channel lifecycle (start/stop)
- **Webhook Handler**: HTTP endpoint that receives and validates incoming events
- **Bot/Provider**: Message processing logic that handles incoming events and sends responses
- **Channel Registry**: System that discovers and manages available channels

## Architecture Overview

```
┌──────────────────┐
│   Platform       │  (Telegram, LINE, Custom Service)
│   Webhook        │
└────────┬─────────┘
         │ HTTP POST
         ▼
┌──────────────────┐
│  Gateway HTTP    │
│  Server          │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Webhook Handler  │  - Signature validation
│                  │  - Event parsing
│                  │  - Return 200 immediately
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Bot/Message      │  - Process events
│ Processor        │  - Generate AI responses
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Auto-Reply       │  - Dispatch to agent
│ System           │  - Format response
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Send Response    │  - Deliver via platform API
└──────────────────┘
```

## Implementation Steps

### Step 1: Create Webhook Handler

Create a file `src/your-channel/webhook.ts`:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { RuntimeEnv } from "../runtime.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { defaultRuntime } from "../runtime.js";

export interface StartYourChannelWebhookOptions {
  apiKey: string;
  secret: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
  onEvent: (event: YourChannelEvent) => Promise<void>;
}

export async function startYourChannelWebhook(opts: StartYourChannelWebhookOptions) {
  const path = opts.path ?? "/your-channel-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check endpoint
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    // Webhook endpoint
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ 
        channel: "your-channel", 
        updateType: "webhook-event" 
      });
    }

    try {
      // Read request body
      const body = await readRequestBody(req);
      
      // Validate signature (CRITICAL for security)
      const signature = req.headers["x-your-channel-signature"];
      if (!signature || !validateSignature(body, signature as string, opts.secret)) {
        runtime.log?.("webhook signature validation failed");
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      // Parse event
      const event = JSON.parse(body) as YourChannelEvent;

      // Respond immediately to avoid timeout (IMPORTANT)
      res.writeHead(200);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));

      // Process event asynchronously
      await opts.onEvent(event).catch((err) => {
        const errMsg = formatErrorMessage(err);
        if (diagnosticsEnabled) {
          logWebhookError({
            channel: "your-channel",
            updateType: "webhook-event",
            error: errMsg,
          });
        }
        runtime.error?.(`webhook handler failed: ${errMsg}`);
      });

      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "your-channel",
          updateType: "webhook-event",
          durationMs: Date.now() - startTime,
        });
      }
    } catch (err) {
      const errMsg = formatErrorMessage(err);
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "your-channel",
          updateType: "webhook-event",
          error: errMsg,
        });
      }
      runtime.error?.(`webhook error: ${errMsg}`);
      
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  // Start server
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  
  const publicUrl = opts.publicUrl ?? 
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  
  runtime.log?.(`webhook listening on ${publicUrl}`);

  // Setup shutdown handler
  const shutdown = () => {
    server.close();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, stop: shutdown, publicUrl };
}

// Helper to read request body
async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// Signature validation (implement based on your platform's requirements)
function validateSignature(body: string, signature: string, secret: string): boolean {
  const crypto = await import("node:crypto");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expectedSignature = hmac.digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

### Step 2: Create Monitor Function

Create a file `src/your-channel/monitor.ts` that uses the plugin HTTP registry:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { logVerbose, danger } from "../globals.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { createYourChannelBot } from "./bot.js";
import { validateSignature } from "./signature.js";

export interface MonitorYourChannelProviderOptions {
  apiKey: string;
  secret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
}

export interface YourChannelProviderMonitor {
  account: ResolvedYourChannelAccount;
  stop: () => void;
}

export async function monitorYourChannelProvider(
  opts: MonitorYourChannelProviderOptions
): Promise<YourChannelProviderMonitor> {
  const {
    apiKey,
    secret,
    accountId,
    config,
    runtime,
    abortSignal,
    webhookPath,
  } = opts;
  const resolvedAccountId = accountId ?? "default";

  // Create the bot/message processor
  const bot = createYourChannelBot({
    apiKey,
    secret,
    accountId: resolvedAccountId,
    runtime,
    config,
    onMessage: async (ctx) => {
      // Process incoming message and send to auto-reply system
      logVerbose(`your-channel: received message from ${ctx.userId}`);
      
      // Dispatch to OpenClaw's auto-reply system
      const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctx.payload,
        cfg: config,
        dispatcherOptions: {
          deliver: async (payload, _info) => {
            // Send response back to user
            await bot.sendMessage({
              to: ctx.userId,
              text: payload.text,
            });
          },
          onError: (err, info) => {
            runtime.error?.(danger(`your-channel ${info.kind} reply failed: ${String(err)}`));
          },
        },
        replyOptions: {},
      });

      if (!queuedFinal) {
        logVerbose(`your-channel: no response generated`);
      }
    },
  });

  // Register HTTP webhook handler using plugin system
  const normalizedPath = normalizePluginHttpPath(
    webhookPath, 
    "/your-channel/webhook"
  ) ?? "/your-channel/webhook";

  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "your-channel",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Handle verification GET requests
      if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("OK");
        return;
      }

      // Only accept POST requests
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      try {
        // Read raw body
        const rawBody = await readRequestBody(req);
        const signature = req.headers["x-your-channel-signature"];

        // Validate signature
        if (!signature || typeof signature !== "string") {
          logVerbose("your-channel: webhook missing signature header");
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing signature header" }));
          return;
        }

        if (!validateSignature(rawBody, signature, secret)) {
          logVerbose("your-channel: webhook signature validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        // Parse event
        const event = JSON.parse(rawBody);

        // Respond immediately with 200 (CRITICAL)
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Process events asynchronously
        if (event.type === "message") {
          logVerbose(`your-channel: processing webhook event`);
          await bot.handleEvent(event).catch((err) => {
            runtime.error?.(danger(`webhook handler failed: ${String(err)}`));
          });
        }
      } catch (err) {
        runtime.error?.(danger(`webhook error: ${String(err)}`));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  logVerbose(`your-channel: registered webhook handler at ${normalizedPath}`);

  // Handle abort signal for graceful shutdown
  const stopHandler = () => {
    logVerbose(`your-channel: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
  };

  abortSignal?.addEventListener("abort", stopHandler);

  return {
    account: bot.account,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

### Step 3: Register Gateway Adapter

Create or update `src/channels/plugins/your-channel.ts`:

```typescript
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelGatewayAdapter } from "./types.adapters.js";
import { monitorYourChannelProvider } from "../../your-channel/monitor.js";

export const yourChannelPlugin: ChannelPlugin = {
  id: "your-channel",
  name: "Your Channel",
  
  // Gateway adapter - manages lifecycle
  gateway: {
    startAccount: async (ctx) => {
      const apiKey = ctx.account.credentials?.apiKey;
      const secret = ctx.account.credentials?.secret;
      
      if (!apiKey || !secret) {
        throw new Error("Missing API key or secret for Your Channel");
      }

      const monitor = await monitorYourChannelProvider({
        apiKey,
        secret,
        accountId: ctx.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: ctx.account.webhookPath,
      });

      // Return monitor or undefined (framework handles cleanup)
      return monitor;
    },

    stopAccount: async (ctx) => {
      // Optional: custom cleanup logic
      ctx.runtime.log?.(`stopping your-channel account ${ctx.accountId}`);
    },
  },

  // Other adapters (outbound, pairing, etc.)
  outbound: {
    // Implement sendText, sendMedia, etc.
  },
};
```

### Step 4: Register Plugin in Catalog

Update `src/channels/registry.ts`:

```typescript
// Add to channel order
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "line",
  "your-channel", // Add here
  // ... other channels
];

// Add metadata
export const CHAT_CHANNEL_META: Record<string, ChannelMeta> = {
  // ... existing channels
  "your-channel": {
    id: "your-channel",
    name: "Your Channel",
    icon: "🌐",
    supportedFeatures: ["text", "media", "reactions"],
  },
};
```

## Cloudflare WebSocket Example

For Cloudflare Workers using WebSocket, you can create a serverless webhook handler:

### Cloudflare Worker Implementation

```typescript
// worker.ts - Deploy to Cloudflare Workers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const body = await request.text();
        const signature = request.headers.get("x-signature");

        // Validate signature
        if (!signature || !(await validateSignature(body, signature, env.WEBHOOK_SECRET))) {
          return new Response(
            JSON.stringify({ error: "Invalid signature" }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          );
        }

        const event = JSON.parse(body);

        // Forward to your OpenClaw gateway via WebSocket or HTTP
        await forwardToGateway(event, env.GATEWAY_URL, env.GATEWAY_TOKEN);

        // Respond immediately
        return new Response(
          JSON.stringify({ status: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        console.error("Webhook error:", err);
        return new Response(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function validateSignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigBuffer = hexToBuffer(signature);
  const dataBuffer = encoder.encode(body);

  return crypto.subtle.verify("HMAC", key, sigBuffer, dataBuffer);
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

async function forwardToGateway(
  event: unknown,
  gatewayUrl: string,
  token: string
): Promise<void> {
  await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(event),
  });
}
```

### Deploy to Cloudflare

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Configure wrangler.toml
cat > wrangler.toml <<EOF
name = "openclaw-webhook"
main = "worker.ts"
compatibility_date = "2024-01-01"

[vars]
GATEWAY_URL = "https://your-gateway.example.com/webhook"

[secrets]
WEBHOOK_SECRET = "your-secret-key"
GATEWAY_TOKEN = "your-gateway-token"
EOF

# Deploy
wrangler deploy
```

## Security Best Practices

### 1. Signature Validation

**Always validate webhook signatures** before processing events:

```typescript
import crypto from "node:crypto";

function validateHmacSha256(
  body: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expectedSignature = hmac.digest("hex");
  
  // Use timing-safe comparison
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

### 2. Return 200 Immediately

**Respond quickly** to avoid timeouts:

```typescript
// ✅ GOOD: Respond immediately, process async
res.writeHead(200);
res.end(JSON.stringify({ status: "ok" }));

// Then process asynchronously
void processEvent(event).catch((err) => {
  runtime.error?.(`async processing failed: ${err}`);
});

// ❌ BAD: Process before responding (can timeout)
await processEvent(event);
res.writeHead(200);
res.end();
```

### 3. Error Handling

**Catch and log errors** without crashing:

```typescript
try {
  await processEvent(event);
} catch (err) {
  runtime.error?.(`event processing failed: ${formatErrorMessage(err)}`);
  // Don't throw - the webhook already responded with 200
}
```

### 4. Graceful Shutdown

**Listen for abort signals** and clean up:

```typescript
const stopHandler = () => {
  unregisterHttpRoute();
  server.close();
};

abortSignal?.addEventListener("abort", stopHandler);
```

## Testing Your Webhook

### Local Testing

1. **Start the gateway**:
   ```bash
   openclaw gateway run --bind loopback --port 18789
   ```

2. **Use ngrok for local webhook testing**:
   ```bash
   ngrok http 18789
   ```

3. **Send test webhook**:
   ```bash
   curl -X POST http://localhost:18789/your-channel/webhook \
     -H "Content-Type: application/json" \
     -H "X-Your-Channel-Signature: <signature>" \
     -d '{"type":"message","text":"Hello"}'
   ```

### Unit Testing

```typescript
import { describe, it, expect, vi } from "vitest";
import { monitorYourChannelProvider } from "./monitor.js";

describe("YourChannel webhook", () => {
  it("validates signatures correctly", async () => {
    const secret = "test-secret";
    const body = '{"type":"message"}';
    
    const signature = createTestSignature(body, secret);
    const isValid = validateSignature(body, signature, secret);
    
    expect(isValid).toBe(true);
  });

  it("rejects invalid signatures", async () => {
    const secret = "test-secret";
    const body = '{"type":"message"}';
    const badSignature = "invalid";
    
    const isValid = validateSignature(body, badSignature, secret);
    
    expect(isValid).toBe(false);
  });
});
```

## Configuration

Add channel configuration to your OpenClaw config:

```yaml
channels:
  your-channel:
    accounts:
      - id: main
        enabled: true
        credentials:
          apiKey: "your-api-key"
          secret: "your-secret"
        webhookPath: "/your-channel/webhook"
        publicUrl: "https://your-domain.com/your-channel/webhook"
```

## Troubleshooting

### Webhook Not Receiving Events

1. **Check webhook registration**:
   ```bash
   openclaw channels status --deep
   ```

2. **Verify signature validation**:
   - Log the raw body and signature
   - Compare with platform documentation
   - Ensure secret is correct

3. **Check gateway logs**:
   ```bash
   tail -f ~/.openclaw/gateway.log
   ```

### Signature Validation Failing

- **Raw body required**: Read body before JSON parsing for signature validation
- **Encoding matters**: Ensure UTF-8 encoding
- **Header format**: Check if signature is hex, base64, or prefixed (e.g., `sha256=...`)

### Timeout Issues

- **Respond immediately**: Don't wait for processing to complete
- **Async processing**: Use `.catch()` for error handling, don't await
- **Health checks**: Implement `/healthz` endpoint for platform verification

## Advanced Patterns

### WebSocket for Real-time Updates

If your platform supports WebSocket for bi-directional communication:

```typescript
import { WebSocket } from "ws";

export function connectYourChannelWebSocket(opts: {
  url: string;
  token: string;
  onMessage: (msg: Message) => Promise<void>;
  abortSignal?: AbortSignal;
}) {
  const ws = new WebSocket(opts.url, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
    },
  });

  ws.on("open", () => {
    console.log("WebSocket connected");
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await opts.onMessage(msg);
    } catch (err) {
      console.error("Message processing failed:", err);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  ws.on("close", () => {
    console.log("WebSocket disconnected");
  });

  const cleanup = () => {
    ws.close();
  };

  opts.abortSignal?.addEventListener("abort", cleanup);

  return { ws, stop: cleanup };
}
```

### Rate Limiting

Implement rate limiting for webhook endpoints:

```typescript
import { RateLimiter } from "limiter";

const limiter = new RateLimiter({
  tokensPerInterval: 100,
  interval: "minute",
});

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  const remainingRequests = await limiter.removeTokens(1);
  
  if (remainingRequests < 0) {
    res.writeHead(429, { "Retry-After": "60" });
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }
  
  // Process webhook...
}
```

## Reference Implementations

See existing webhook implementations for complete examples:

- **Telegram**: `src/telegram/webhook.ts` - HTTP webhook with grammy framework
- **LINE**: `src/line/webhook.ts`, `src/line/monitor.ts` - HTTP webhook with plugin registry
- **Gateway HTTP**: `src/gateway/server-http.ts` - HTTP server setup

## Additional Resources

- [OpenClaw Gateway Architecture](/gateway)
- [Channel Plugin Development](/channels/plugins)
- [Security Guidelines](/security)
- [Testing Guide](/testing)

## Summary

Key points for webhook gateway integration:

1. ✅ **Validate signatures** before processing
2. ✅ **Return 200 immediately** to avoid timeouts
3. ✅ **Process asynchronously** with error handling
4. ✅ **Use plugin HTTP registry** for route registration
5. ✅ **Handle abort signals** for graceful shutdown
6. ✅ **Add diagnostic logging** for debugging
7. ✅ **Test locally** with ngrok or similar tools
8. ✅ **Document configuration** for users

Following these patterns ensures your webhook gateway is **secure**, **reliable**, and **maintainable**.
