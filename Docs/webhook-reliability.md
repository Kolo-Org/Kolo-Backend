## Webhook Reliability

The WhatsApp webhook (`POST /api/webhook`) is the ingress for every user action,
so it is built to fail gracefully and never drop a message silently.

### Payload handling

* The webhook body is untrusted input. `BotController.extractTextMessage` reads
  it with optional chaining end-to-end, so a malformed or hostile payload (for
  example `{ object: 'x', entry: [] }`) can never throw a `TypeError`.
* `from` and the message body are validated as non-empty strings before a job is
  enqueued.

### Response codes

| Situation | Status | Reason |
| --- | --- | --- |
| Valid text message enqueued | `200` | Acknowledge delivery |
| Valid event with nothing to process (status update, empty/ non-text body) | `200` | Acknowledge; nothing to do |
| Payload is not a recognised webhook object | `404` | Not for us |
| Queue/Redis failure or enqueue timeout | `500` | Signals WhatsApp to retry so the message is not lost |

### Enqueue safety

* `enqueueMessage` is wrapped in `try/catch`; a queue/Redis failure is logged and
  answered with `500` instead of escaping as an unhandled promise rejection.
* `enqueueWithTimeout` applies a hard 10s timeout so a stalled queue connection
  cannot hang the request. The timer is always cleared.

### Process-level safety net

* `process.on('unhandledRejection')` logs any rejection that still escapes a
  handler, worker, or timer.
* `process.on('uncaughtException')` logs and exits so the orchestrator can
  restart the process with clean state.
* Express error-handling middleware turns any error forwarded from an async
  route handler into a clean `500`.

### Tests

Reliability behaviour is covered in `src/__tests__/bot.controller.test.ts`
(malformed payloads, enqueue failure, and enqueue timeout), with 100% coverage
of `src/controllers/bot.controller.ts`.
