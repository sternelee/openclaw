# Webhook Gateway Documentation

Documentation and examples for implementing webhook-based channel integrations in OpenClaw.

## Quick Links

- **[Webhook Integration Guide](./webhook-integration.md)** - Complete implementation guide
- **[Quick Reference](./webhook-quick-reference.md)** - Essential patterns and code snippets
- **[Cloudflare Example](./webhook-example-cloudflare.md)** - Production-ready serverless implementation
- **[Example Code](./webhook-example-implementation.ts)** - Copy-paste template

## Overview

OpenClaw supports webhook-based integrations for messaging platforms that push events to your server (e.g., Telegram, LINE, custom services). Webhooks provide real-time message delivery without polling.

## Getting Started

### 1. Read the Integration Guide

Start with [webhook-integration.md](./webhook-integration.md) for a comprehensive understanding of:

- Architecture and patterns
- Security best practices
- Step-by-step implementation
- Testing and deployment

### 2. Review Quick Reference

Check [webhook-quick-reference.md](./webhook-quick-reference.md) for:

- Code templates
- Common patterns
- Signature validation examples
- Troubleshooting tips

### 3. Study Production Example

See [webhook-example-cloudflare.md](./webhook-example-cloudflare.md) for:

- Cloudflare Workers deployment
- WebSocket relay pattern
- Rate limiting and DDoS protection
- Monitoring and observability

### 4. Copy Example Code

Use [webhook-example-implementation.ts](./webhook-example-implementation.ts) as a starting template.

## Key Concepts

### Webhook Flow

```
Platform → Webhook HTTP POST → Signature Validation → Event Processing → AI Response → Platform API
```

### Essential Patterns

1. **Signature Validation** - Always validate before processing
2. **Immediate Response** - Return 200 immediately, process async
3. **Plugin Registry** - Use `registerPluginHttpRoute` for routes
4. **Graceful Shutdown** - Handle abort signals properly

## Architecture

```
┌──────────────────┐
│   Platform       │  (Telegram, LINE, etc.)
│   Webhook        │
└────────┬─────────┘
         │ HTTP POST
         ▼
┌──────────────────┐
│  Gateway HTTP    │  - Validate signature
│  Server          │  - Return 200 immediately
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Event Processor  │  - Parse event
│                  │  - Process asynchronously
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Auto-Reply       │  - Generate AI response
│ System           │  - Format output
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Platform API     │  - Send response
└──────────────────┘
```

## Security Checklist

Before deploying your webhook:

- [ ] Signature validation implemented and tested
- [ ] Using timing-safe comparison for signatures
- [ ] HTTPS only (no HTTP in production)
- [ ] Rate limiting configured
- [ ] Error messages don't leak secrets
- [ ] Logging security events
- [ ] Secrets stored securely (not in code)

## Testing Checklist

Before going to production:

- [ ] Local testing with ngrok
- [ ] Signature validation tests
- [ ] Invalid signature rejection
- [ ] Timeout handling (immediate 200 response)
- [ ] Error handling and logging
- [ ] Graceful shutdown
- [ ] Load testing (if high volume expected)

## Common Platforms

### Signature Validation Methods

| Platform | Method | Header |
|----------|--------|--------|
| Telegram | HMAC-SHA256 or secret token | `X-Telegram-Bot-Api-Secret-Token` |
| LINE | HMAC-SHA256 base64 | `X-Line-Signature` |
| GitHub | HMAC-SHA256 hex with prefix | `X-Hub-Signature-256` |
| Slack | HMAC-SHA256 hex with prefix | `X-Slack-Signature` |
| Discord | Ed25519 signature | `X-Signature-Ed25519` |

See [webhook-quick-reference.md](./webhook-quick-reference.md) for code examples.

## File Structure

When implementing a new channel:

```
src/
├── your-channel/
│   ├── monitor.ts          # Gateway monitor (webhook handler)
│   ├── bot.ts              # Message processor
│   ├── send.ts             # Outbound delivery
│   ├── signature.ts        # Signature validation
│   └── types.ts            # TypeScript types
└── channels/
    └── plugins/
        └── your-channel.ts # Channel plugin registration
```

## Configuration

Example channel configuration:

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

## Troubleshooting

### Webhook Not Receiving Events

1. Check webhook is registered: `openclaw channels status`
2. Verify signature validation logic
3. Check gateway logs: `tail -f ~/.openclaw/gateway.log`
4. Test endpoint with curl

### Signature Validation Failing

1. Read raw body before JSON parsing
2. Verify signature format (hex, base64, prefixed?)
3. Check secret is correct
4. Log expected vs received signatures

### Platform Timeouts

1. Return 200 immediately (don't await processing)
2. Process events asynchronously
3. Check response time is < 1 second

See [webhook-quick-reference.md](./webhook-quick-reference.md) for more troubleshooting tips.

## Reference Implementations

Study these existing implementations:

- **Telegram**: `src/telegram/webhook.ts` - HTTP webhook with grammy
- **LINE**: `src/line/monitor.ts` - Plugin registry pattern
- **Gateway HTTP**: `src/gateway/server-http.ts` - Core HTTP server

## Further Reading

- [Gateway Index](./index.md) - Main gateway documentation
- [Channel Plugins](../channels/plugins) - Plugin system overview
- [Security Guidelines](../../SECURITY.md) - Security best practices

## Getting Help

- Check [webhook-quick-reference.md](./webhook-quick-reference.md) for common patterns
- Review [webhook-integration.md](./webhook-integration.md) for detailed explanations
- Study existing implementations in `src/telegram/webhook.ts` and `src/line/monitor.ts`

## Contributing

When adding new webhook integrations:

1. Follow the patterns in this documentation
2. Include signature validation
3. Add tests for validation logic
4. Document platform-specific details
5. Update this README with your platform

## License

OpenClaw is licensed under the MIT License. See [LICENSE](../../LICENSE) for details.
