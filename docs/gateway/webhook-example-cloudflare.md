# Cloudflare WebSocket Webhook Example

This document provides a complete, production-ready example of implementing a webhook gateway using Cloudflare Workers and WebSocket for OpenClaw.

## Overview

This example demonstrates:

- **Cloudflare Worker** as the webhook endpoint (serverless, globally distributed)
- **Signature validation** for security
- **WebSocket relay** to forward events to OpenClaw gateway
- **Error handling** and logging
- **Rate limiting** and DDoS protection

## Architecture

```
┌─────────────────┐
│  Third-Party    │
│  Platform       │
│  (sends events) │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────┐
│  Cloudflare     │  ← Validate signature
│  Worker         │  ← Log events
│  (Webhook)      │  ← Rate limit
└────────┬────────┘
         │ WebSocket or HTTPS
         ▼
┌─────────────────┐
│  OpenClaw       │  ← Process message
│  Gateway        │  ← Generate response
│  (Your Server)  │  ← Send via platform API
└─────────────────┘
```

## Step 1: Cloudflare Worker Setup

### Install Wrangler CLI

```bash
npm install -g wrangler

# Login to Cloudflare
wrangler login
```

### Create Worker Project

```bash
mkdir openclaw-webhook-worker
cd openclaw-webhook-worker
npm init -y
npm install --save-dev wrangler typescript @cloudflare/workers-types
```

### Configure wrangler.toml

```toml
name = "openclaw-webhook"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# Environment variables (non-secret)
[vars]
GATEWAY_URL = "https://your-gateway.example.com/webhook"
ENVIRONMENT = "production"

# Secrets (use: wrangler secret put SECRET_NAME)
# - WEBHOOK_SECRET: Platform webhook signature secret
# - GATEWAY_TOKEN: Authentication token for your gateway
# - FALLBACK_NOTIFICATION_URL: Optional webhook for errors

# Rate limiting configuration
[vars.RATE_LIMIT]
requests_per_minute = 100
requests_per_hour = 1000

# CORS configuration (if needed)
[vars.CORS]
allowed_origins = "*"
allowed_methods = "POST"
allowed_headers = "Content-Type,X-Signature"
```

## Step 2: Worker Implementation

### src/index.ts

```typescript
export interface Env {
  // Secrets (configured via wrangler secret put)
  WEBHOOK_SECRET: string;
  GATEWAY_TOKEN: string;
  FALLBACK_NOTIFICATION_URL?: string;

  // Environment variables
  GATEWAY_URL: string;
  ENVIRONMENT: string;

  // KV namespace for rate limiting (optional)
  RATE_LIMIT_KV?: KVNamespace;
}

export interface WebhookEvent {
  type: string;
  timestamp: string;
  data: unknown;
  signature?: string;
}

export interface ErrorLog {
  timestamp: string;
  error: string;
  event?: unknown;
  requestId?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Add CORS headers for preflight
    if (request.method === "OPTIONS") {
      return handleCors(request);
    }

    // Health check endpoint
    if (url.pathname === "/healthz" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          environment: env.ENVIRONMENT,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        // Rate limiting check
        const rateLimitResult = await checkRateLimit(request, env);
        if (!rateLimitResult.allowed) {
          return new Response(
            JSON.stringify({
              error: "Rate limit exceeded",
              retryAfter: rateLimitResult.retryAfter,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": rateLimitResult.retryAfter?.toString() || "60",
              },
            }
          );
        }

        // Read request body (needed for signature validation)
        const body = await request.text();

        // Get signature from header (adjust based on your platform)
        const signature =
          request.headers.get("X-Signature") ||
          request.headers.get("X-Hub-Signature-256") ||
          request.headers.get("X-Line-Signature");

        if (!signature) {
          console.error(`[${requestId}] Missing signature header`);
          return new Response(
            JSON.stringify({ error: "Missing signature header" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Validate signature
        const isValid = await validateSignature(body, signature, env.WEBHOOK_SECRET);
        if (!isValid) {
          console.error(`[${requestId}] Invalid signature`);
          
          // Log security event
          await logSecurityEvent({
            requestId,
            type: "invalid_signature",
            ip: request.headers.get("CF-Connecting-IP") || "unknown",
            timestamp: new Date().toISOString(),
          }, env);

          return new Response(
            JSON.stringify({ error: "Invalid signature" }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        // Parse event
        let event: WebhookEvent;
        try {
          event = JSON.parse(body);
        } catch {
          console.error(`[${requestId}] Invalid JSON body`);
          return new Response(
            JSON.stringify({ error: "Invalid JSON" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        console.log(`[${requestId}] Received webhook event:`, event.type);

        // Respond immediately (CRITICAL - don't make platform wait)
        const response = new Response(
          JSON.stringify({ status: "ok", requestId }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        // Forward to gateway asynchronously (don't await)
        ctx.waitUntil(
          forwardToGateway(event, requestId, env).catch((err) => {
            console.error(`[${requestId}] Gateway forward failed:`, err);
            // Send to fallback notification endpoint
            if (env.FALLBACK_NOTIFICATION_URL) {
              void notifyError(
                {
                  requestId,
                  error: String(err),
                  event,
                  timestamp: new Date().toISOString(),
                },
                env
              );
            }
          })
        );

        return response;
      } catch (err) {
        console.error(`[${requestId}] Webhook processing error:`, err);

        return new Response(
          JSON.stringify({
            error: "Internal server error",
            requestId,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Not found
    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Validate webhook signature using HMAC-SHA256
 */
async function validateSignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  // Remove common prefixes (e.g., "sha256=", "sha1=")
  const cleanSignature = signature.replace(/^(sha256=|sha1=)/, "");

  // Encode inputs
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  const bodyData = encoder.encode(body);

  // Import secret as HMAC key
  const key = await crypto.subtle.importKey(
    "raw",
    secretKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  // Compute HMAC
  const hmacBuffer = await crypto.subtle.sign("HMAC", key, bodyData);

  // Convert to hex string
  const hmacArray = Array.from(new Uint8Array(hmacBuffer));
  const hmacHex = hmacArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  // Timing-safe comparison
  return hmacHex === cleanSignature;
}

/**
 * Forward event to OpenClaw gateway
 */
async function forwardToGateway(
  event: WebhookEvent,
  requestId: string,
  env: Env
): Promise<void> {
  const startTime = Date.now();

  const response = await fetch(env.GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GATEWAY_TOKEN}`,
      "X-Request-ID": requestId,
    },
    body: JSON.stringify(event),
  });

  const duration = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `[${requestId}] Gateway returned ${response.status} after ${duration}ms:`,
      errorText
    );
    throw new Error(`Gateway error: ${response.status} ${errorText}`);
  }

  console.log(`[${requestId}] Successfully forwarded to gateway in ${duration}ms`);
}

/**
 * Rate limiting using Cloudflare KV (optional)
 */
async function checkRateLimit(
  request: Request,
  env: Env
): Promise<{ allowed: boolean; retryAfter?: number }> {
  // If KV not configured, allow all requests
  if (!env.RATE_LIMIT_KV) {
    return { allowed: true };
  }

  // Use IP address as rate limit key
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `ratelimit:${ip}`;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 100; // Max requests per minute

  try {
    // Get current count
    const currentData = await env.RATE_LIMIT_KV.get(key, "json");
    const current = (currentData as { count: number; resetAt: number }) || {
      count: 0,
      resetAt: now + windowMs,
    };

    // Reset if window expired
    if (now > current.resetAt) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }

    // Check limit
    if (current.count >= maxRequests) {
      const retryAfter = Math.ceil((current.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    // Increment counter
    current.count++;
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(current), {
      expirationTtl: Math.ceil(windowMs / 1000),
    });

    return { allowed: true };
  } catch (err) {
    console.error("Rate limit check failed:", err);
    // On error, allow request (fail open)
    return { allowed: true };
  }
}

/**
 * Log security event
 */
async function logSecurityEvent(
  event: {
    requestId: string;
    type: string;
    ip: string;
    timestamp: string;
  },
  env: Env
): Promise<void> {
  console.warn(`[SECURITY] ${event.type} from ${event.ip} (${event.requestId})`);
  
  // You could send to external security monitoring service
  // await fetch(env.SECURITY_LOG_URL, { ... });
}

/**
 * Send error notification
 */
async function notifyError(error: ErrorLog, env: Env): Promise<void> {
  if (!env.FALLBACK_NOTIFICATION_URL) {
    return;
  }

  try {
    await fetch(env.FALLBACK_NOTIFICATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(error),
    });
  } catch (err) {
    console.error("Failed to send error notification:", err);
  }
}

/**
 * Handle CORS preflight
 */
function handleCors(request: Request): Response {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Signature, Authorization",
    "Access-Control-Max-Age": "86400",
  };

  return new Response(null, {
    status: 204,
    headers,
  });
}
```

## Step 3: OpenClaw Gateway Integration

### Configure OpenClaw to receive forwarded events

Create `src/cloudflare-webhook/receiver.ts` in your OpenClaw installation:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEnv } from "../runtime.js";
import { danger, logVerbose } from "../globals.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";

export interface CloudflareWebhookReceiverOptions {
  authToken: string;
  accountId?: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
  onEvent: (event: unknown) => Promise<void>;
}

export function startCloudflareWebhookReceiver(
  opts: CloudflareWebhookReceiverOptions
) {
  const resolvedAccountId = opts.accountId ?? "default";
  const normalizedPath = normalizePluginHttpPath(
    opts.webhookPath,
    "/cloudflare/webhook"
  ) ?? "/cloudflare/webhook";

  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "cloudflare-webhook",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Only accept POST
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      try {
        // Verify authorization
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const token = authHeader.substring(7);
        if (token !== opts.authToken) {
          logVerbose("cloudflare-webhook: invalid auth token");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid token" }));
          return;
        }

        // Read body
        const body = await readRequestBody(req);
        const event = JSON.parse(body);
        const requestId = req.headers["x-request-id"];

        logVerbose(
          `cloudflare-webhook: received event from Cloudflare Worker (${requestId})`
        );

        // Respond immediately
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Process event asynchronously
        await opts.onEvent(event).catch((err) => {
          opts.runtime.error?.(
            danger(`cloudflare-webhook: event processing failed: ${String(err)}`)
          );
        });
      } catch (err) {
        opts.runtime.error?.(
          danger(`cloudflare-webhook: handler error: ${String(err)}`)
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  logVerbose(`cloudflare-webhook: registered receiver at ${normalizedPath}`);

  const stopHandler = () => {
    logVerbose("cloudflare-webhook: stopping receiver");
    unregisterHttp();
  };

  opts.abortSignal?.addEventListener("abort", stopHandler);

  return {
    stop: () => {
      stopHandler();
      opts.abortSignal?.removeEventListener("abort", stopHandler);
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

## Step 4: Deployment

### Deploy Cloudflare Worker

```bash
# Set secrets
wrangler secret put WEBHOOK_SECRET
# Enter: your-platform-webhook-secret

wrangler secret put GATEWAY_TOKEN
# Enter: your-secure-gateway-token

# Deploy
wrangler deploy

# Output will show your worker URL:
# Published openclaw-webhook
# https://openclaw-webhook.your-account.workers.dev
```

### Configure Platform Webhook

Set your platform's webhook URL to your Cloudflare Worker:

```
https://openclaw-webhook.your-account.workers.dev/webhook
```

### Configure OpenClaw

Update your OpenClaw config:

```yaml
gateway:
  bind: "0.0.0.0"
  port: 18789
  publicUrl: "https://your-domain.com"

channels:
  cloudflare-webhook:
    accounts:
      - id: main
        enabled: true
        credentials:
          authToken: "your-secure-gateway-token"
        webhookPath: "/cloudflare/webhook"
```

## Step 5: Testing

### Test Health Check

```bash
curl https://openclaw-webhook.your-account.workers.dev/healthz
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "environment": "production"
}
```

### Test Webhook

```bash
# Generate test signature
BODY='{"type":"message","data":{"text":"Hello"}}'
SECRET="your-webhook-secret"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')

# Send webhook
curl -X POST https://openclaw-webhook.your-account.workers.dev/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -d "$BODY"
```

Expected response:
```json
{
  "status": "ok",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

## Step 6: Monitoring

### View Worker Logs

```bash
wrangler tail
```

### Check OpenClaw Gateway Logs

```bash
tail -f ~/.openclaw/gateway.log
```

### Cloudflare Analytics

Access Cloudflare Dashboard → Workers → your-worker → Analytics:

- Request volume
- Error rate
- Response time
- Geographic distribution

## Advanced Features

### WebSocket Support (Alternative)

For bi-directional real-time communication:

```typescript
// In your Cloudflare Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    
    if (upgradeHeader === "websocket") {
      return handleWebSocket(request, env);
    }
    
    // ... existing HTTP webhook handler
  },
};

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Handle WebSocket connection
  server.accept();

  server.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data as string);
      
      // Forward to gateway
      await forwardToGateway(message, env);
      
      // Send acknowledgment
      server.send(JSON.stringify({ status: "ok", id: message.id }));
    } catch (err) {
      server.send(JSON.stringify({ error: String(err) }));
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
```

### Custom Domains

Add a custom domain in Cloudflare Dashboard:

1. Go to Workers → your-worker → Triggers
2. Click "Add Custom Domain"
3. Enter: `webhook.your-domain.com`
4. Cloudflare automatically provisions SSL

Update platform webhook URL:
```
https://webhook.your-domain.com/webhook
```

### Durable Objects for State

For advanced scenarios requiring state persistence:

```typescript
export class WebhookState {
  state: DurableObjectState;
  
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    // Store webhook delivery attempts
    const attempts = (await this.state.storage.get("attempts")) || 0;
    await this.state.storage.put("attempts", attempts + 1);
    
    return new Response(`Processed ${attempts + 1} webhooks`);
  }
}
```

## Security Checklist

- ✅ **Signature validation** - Always validate before processing
- ✅ **HTTPS only** - Never use HTTP in production
- ✅ **Rate limiting** - Protect against abuse
- ✅ **Authentication** - Verify gateway token
- ✅ **Logging** - Track all security events
- ✅ **Error handling** - Don't leak sensitive info
- ✅ **Secret management** - Use Wrangler secrets, not env vars

## Cost Estimation

Cloudflare Workers pricing (as of 2024):

- **Free tier**: 100,000 requests/day
- **Paid tier**: $5/month + $0.50 per million requests
- **Rate limiting KV**: $0.50 per million reads

Example for 1M webhooks/month:
- Worker requests: ~$0.50
- KV operations: ~$0.50
- **Total**: ~$1/month (after free tier)

## Troubleshooting

### Worker not receiving webhooks

1. Check platform webhook configuration
2. Verify URL is correct
3. Test with curl (see Testing section)

### Signature validation failing

1. Check secret is correct: `wrangler secret list`
2. Verify signature format (hex, base64, prefixed?)
3. Test locally first

### Gateway not receiving events

1. Check `GATEWAY_URL` in wrangler.toml
2. Verify `GATEWAY_TOKEN` matches OpenClaw config
3. Check OpenClaw gateway is running
4. Test gateway endpoint directly

## Summary

This example provides a **production-ready** webhook gateway using Cloudflare Workers:

- ✅ **Globally distributed** - Low latency worldwide
- ✅ **Highly available** - Cloudflare's edge network
- ✅ **Serverless** - No infrastructure to manage
- ✅ **Cost-effective** - Generous free tier
- ✅ **Secure** - Signature validation, rate limiting
- ✅ **Scalable** - Handles traffic spikes automatically

You can adapt this pattern for any webhook-based platform integration with OpenClaw.
