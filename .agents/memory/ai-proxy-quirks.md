---
name: Replit AI integrations proxy quirks
description: Non-obvious behavior of the Replit-managed OpenRouter / OpenAI proxies used for bot AI commands.
---

# AI integrations proxy quirks

The bot's AI chat/image commands go through Replit-managed AI integration libs
(OpenRouter for chat, OpenAI for images) — no user-supplied API keys.

- **`models.list` is blocked (405) through the OpenRouter proxy.** You cannot
  enumerate available models to validate the integration. Instead, validate by
  making a real `chat.completions.create` call per model and a real image
  generation call.
  **Why:** a 405 on `models.list` looks like a broken integration but isn't —
  completions still work.
  **How to apply:** when smoke-testing model availability, fire one small real
  completion/image request, don't rely on listing endpoints.
- Chat models are referenced by their OpenRouter slugs (e.g.
  `openai/gpt-4o-mini`, `google/gemini-*`, `anthropic/claude-*`,
  `deepseek/deepseek-chat`, `meta-llama/llama-3.3-70b-instruct`). Image gen uses
  OpenAI `gpt-image-1` via the server image helper.
