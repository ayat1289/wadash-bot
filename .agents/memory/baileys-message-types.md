---
name: Baileys message types
description: Why command/message objects must use Baileys' WAMessage type, not proto.IWebMessageInfo.
---

Type incoming WhatsApp messages (command context, anti-link, media helpers) as Baileys' exported `WAMessage`, NOT `proto.IWebMessageInfo`.

**Why:** The `messages.upsert` event delivers the strict `WAMessage` (where `key` is required). `proto.IWebMessageInfo` has `key?: ... | null | undefined`. APIs like `downloadMediaMessage(target, ...)` and `sendMessage(jid, content, { quoted })` demand the strict `WAMessage`, so a `proto.IWebMessageInfo`-typed value fails typecheck on `key` possibly undefined.

**How to apply:** `import { type WAMessage } from "@whiskeysockets/baileys"`. When constructing a synthetic message for media download (e.g. for a quoted message), cast `{ key: ctx.msg.key, message: quoted } as WAMessage`.

## `group-participants.update` payload (Baileys 7.0.0-rc13)

The `group-participants.update` event's `participants` field is `GroupParticipant[]` (objects with `.id`, `.admin`, …), **NOT** `string[]` of JIDs. A handler that treats them as plain JID strings fails typecheck and would build wrong mentions.

**Why:** Easy to assume string JIDs (older guides / other events use string arrays). The rc13 type is object-based; extract `p.id` for mentions and `jidBase(p.id)` for the display number.

**How to apply:** Type the handler param as `GroupParticipant[]` and the action as `ParticipantAction` (both exported from `@whiskeysockets/baileys`). Welcome/goodbye logic should iterate and use `p.id`.
