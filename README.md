# Chat

## Quick Start
1. `bun install` to grab dependencies.
2. `bun run build:watch` to compile `chat.ts` into `dist/chat.js`.
3. `bun run serve` to host the static files locally.
4. Open `index.html` in a browser and set `window.CHAT_CONFIG` if you need a non-default endpoint.

```html
<script>
  window.CHAT_CONFIG = {
    apiBaseUrl: "http://localhost:11434",
    apiPath: "/v1/chat/completions",
    model: "gemma3:4b",
    systemPrompt: "You are a concise research assistant.",
    apiKey: "optional bearer token",
    headers: { "X-Custom": "value" }
  };
</script>
<script src="dist/core/config.js" defer></script>
```

Define `systemPrompt` to prepend a fixed system message to every conversation. When present, a “System Prompt” pill appears in the header for quick reference. Omit or leave it blank to keep the default model behavior.