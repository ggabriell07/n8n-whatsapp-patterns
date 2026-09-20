# n8n + WhatsApp Production Patterns

Executable and documented patterns for integrating **n8n, WhatsApp transport, multimodal processing and AI workflows** in production-oriented systems.

This repository is intentionally focused on integration engineering rather than product-specific business logic.

## What it demonstrates

- encrypted media key derivation
- multimodal processing boundaries
- stateful multi-step workflows
- payload preservation across workflow nodes
- validation before external API calls
- structured AI integration
- operational guardrails

## Repository structure

```text
src/
  whatsapp-media-keys.js

test/
  whatsapp-media-keys.test.js

docs/
  production-patterns.md

.github/workflows/
  test.yml
```

## Executable media-key reference

The public module demonstrates HKDF-based derivation of WhatsApp media key material for supported media types.

```javascript
const {
  deriveMediaKeys,
} = require('./src/whatsapp-media-keys');

const keys = deriveMediaKeys(
  process.env.EXAMPLE_MEDIA_KEY,
  'audio'
);
```

The result contains separate key material for:

```text
IV
cipher key
MAC key
reference key
```

No real production media keys are included.

## Run tests

Requires Node.js 20+.

```bash
npm test
```

The regression suite verifies:

- deterministic key derivation
- expected key lengths
- separation between media-type HKDF contexts
- rejection of unsupported media types

## n8n runtime note

When using Node.js built-in modules from n8n Code nodes, the allowed built-ins must match the deployment's security configuration.

A representative self-hosted configuration may include:

```text
NODE_FUNCTION_ALLOW_BUILTIN=crypto,https,http
```

Production configuration should be reviewed against the exact n8n version and runner model in use.

## Integration architecture

```text
WhatsApp transport
      ↓
Webhook
      ↓
Payload normalization
      ↓
Media processing if required
  ├── audio → transcription
  └── image → vision
      ↓
Conversation state
      ↓
Domain routing
      ↓
AI / deterministic processing
      ↓
Persistence
      ↓
Validated outbound response
```

## Production lessons

### Preserve downstream context

A workflow node that writes to a database may return only the inserted record. If downstream nodes still require destination, user or response fields, those values must be preserved explicitly.

### Validate before side effects

Do not call an external messaging API when the destination or payload is incomplete.

Do not persist business-critical events when required identifiers are missing.

### Keep transport separate from product logic

WhatsApp-specific media handling should not become the location of domain rules.

The same product logic should be reusable from another transport such as a PWA or native app.

### Persist conversation state

Messaging events are independent requests. Multi-step flows therefore require persistent state.

## Security boundaries

This repository never includes:

- real phone numbers
- real user media
- API tokens
- private webhook headers
- private infrastructure addresses
- production workflow exports with credentials

## Production context

These patterns are related to integration work used while building [Flectos](https://github.com/ggabriell07/flectos).

They are published as sanitized engineering references rather than direct production exports.
