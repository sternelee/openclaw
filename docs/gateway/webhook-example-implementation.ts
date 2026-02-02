/**
 * Example webhook gateway implementation for OpenClaw
 * 
 * This is a minimal working example showing how to implement a webhook-based
 * channel integration. You can copy and adapt this template for your own channel.
 * 
 * @see docs/gateway/webhook-integration.md for detailed documentation
 * @see docs/gateway/webhook-quick-reference.md for quick reference
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { logVerbose, danger } from "../globals.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";

/**
 * Example event structure - adapt to your platform
 */
export interface ExampleWebhookEvent {
  type: "message" | "reaction" | "status";
  id: string;
  timestamp: string;
  userId: string;
  text?: string;
  data?: unknown;
}

/**
 * Monitor options
 */
export interface MonitorExampleProviderOptions {
  apiKey: string;
  secret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
}

/**
 * Monitor result
 */
export interface ExampleProviderMonitor {
  accountId: string;
  stop: () => void;
}

/**
 * Validate webhook signature using HMAC-SHA256
 */
function validateSignature(body: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expectedSignature = hmac.digest("hex");
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Read raw request body (needed for signature validation)
 */
async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Process incoming webhook event
 */
async function processEvent(
  event: ExampleWebhookEvent,
  opts: {
    accountId: string;
    config: OpenClawConfig;
    runtime: RuntimeEnv;
  }
): Promise<void> {
  logVerbose(`example-channel: processing ${event.type} event from ${event.userId}`);

  // Here you would:
  // 1. Convert the event to OpenClaw's internal format
  // 2. Dispatch to the auto-reply system using dispatchReplyWithBufferedBlockDispatcher
  // 3. Send responses back to the user via your platform's API
  
  // Example (simplified):
  // const ctxPayload = convertEventToContext(event);
  // await dispatchReplyWithBufferedBlockDispatcher({
  //   ctx: ctxPayload,
  //   cfg: opts.config,
  //   dispatcherOptions: {
  //     deliver: async (payload) => {
  //       await sendMessageToUser(event.userId, payload.text);
  //     },
  //   },
  // });

  logVerbose(`example-channel: event processed successfully`);
}

/**
 * Start monitoring the example channel
 * 
 * This function:
 * 1. Registers an HTTP webhook handler
 * 2. Validates incoming webhook signatures
 * 3. Processes events asynchronously
 * 4. Handles graceful shutdown
 */
export async function monitorExampleProvider(
  opts: MonitorExampleProviderOptions
): Promise<ExampleProviderMonitor> {
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

  logVerbose(`example-channel: starting monitor for account ${resolvedAccountId}`);

  // Normalize webhook path
  const normalizedPath = normalizePluginHttpPath(
    webhookPath,
    "/example-channel/webhook"
  ) ?? "/example-channel/webhook";

  // Register HTTP webhook handler
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "example-channel",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Health check / verification endpoint (GET)
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
        // Read raw body (needed for signature validation)
        const rawBody = await readRequestBody(req);
        
        // Get signature from header (adjust header name for your platform)
        const signature = req.headers["x-example-signature"];

        // Validate signature (CRITICAL for security)
        if (!signature || typeof signature !== "string") {
          logVerbose("example-channel: webhook missing signature header");
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing signature header" }));
          return;
        }

        if (!validateSignature(rawBody, signature, secret)) {
          logVerbose("example-channel: webhook signature validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        // Parse event
        let event: ExampleWebhookEvent;
        try {
          event = JSON.parse(rawBody);
        } catch {
          logVerbose("example-channel: invalid JSON payload");
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        // Respond immediately with 200 (CRITICAL - don't make platform wait)
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Process event asynchronously
        logVerbose(`example-channel: received ${event.type} webhook event`);
        await processEvent(event, {
          accountId: resolvedAccountId,
          config,
          runtime,
        }).catch((err) => {
          runtime.error?.(
            danger(`example-channel webhook handler failed: ${String(err)}`)
          );
        });
      } catch (err) {
        runtime.error?.(
          danger(`example-channel webhook error: ${String(err)}`)
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  logVerbose(`example-channel: registered webhook handler at ${normalizedPath}`);

  // Handle abort signal for graceful shutdown
  const stopHandler = () => {
    logVerbose(`example-channel: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
  };

  abortSignal?.addEventListener("abort", stopHandler);

  return {
    accountId: resolvedAccountId,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}

/**
 * Example gateway adapter registration
 * 
 * This is how you would register the gateway adapter in your channel plugin.
 * See docs/gateway/webhook-integration.md for complete examples.
 */
export const exampleGatewayAdapter = {
  startAccount: async (ctx: {
    accountId: string;
    account: { credentials?: { apiKey?: string; secret?: string } };
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    abortSignal?: AbortSignal;
  }) => {
    const apiKey = ctx.account.credentials?.apiKey;
    const secret = ctx.account.credentials?.secret;

    if (!apiKey || !secret) {
      throw new Error("Missing API key or secret for Example Channel");
    }

    const monitor = await monitorExampleProvider({
      apiKey,
      secret,
      accountId: ctx.accountId,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
    });

    return monitor;
  },

  stopAccount: async (ctx: { accountId: string; runtime: RuntimeEnv }) => {
    ctx.runtime.log?.(`stopping example-channel account ${ctx.accountId}`);
  },
};
