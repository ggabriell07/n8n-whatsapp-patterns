# Production Integration Patterns

This repository captures implementation patterns that emerged while operating a multimodal conversational system over WhatsApp.

## Patterns

### Preserve state across workflow nodes

Database or API nodes can replace the current payload with their own response. Downstream nodes should not assume transport fields such as user identifier, destination or reply text remain available.

Required context should be preserved explicitly.

### Treat media processing as a pipeline

```text
message metadata
    ↓
media key derivation
    ↓
encrypted media download
    ↓
integrity / decryption
    ↓
speech or vision model
    ↓
normalized application payload
```

Transport-specific concerns should remain separate from domain logic.

### Validate before calling external APIs

Before sending a message or writing an event:

- validate destination/user identity
- validate required content
- validate model output shape
- reject incomplete operational payloads
- record failures with enough context for debugging without exposing secrets

### Persist multi-step state

Messaging webhooks are independent HTTP requests. Multi-step user journeys therefore require explicit application state rather than in-memory assumptions.

### Keep AI optional for deterministic operations

Commands and known state transitions should not require model inference.

## Security

Do not publish or log:

- real media keys
- message URLs containing private access data
- real phone numbers
- credentials
- private webhook headers
- user media
