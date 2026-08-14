---
name: Telegram force-join channel gate
description: How the Telegram pairing-console force-join works and why it fails open; the channel-admin requirement.
---

# Telegram force-join channel gate

The Telegram pairing console can require users to be a member of a configured
Telegram channel before they may use it, and auto-disconnects paired users who
later leave.

## Hard constraint: getChatMember needs the bot to be a channel ADMIN
- Membership is checked with the Bot API `getChatMember(chat_id=@channel, user_id)`.
- For a **channel**, this only succeeds when the bot is an **administrator** of
  that channel. A non-admin bot gets `Bad Request: member list is inaccessible`.
- Therefore the feature does nothing useful until the operator adds the bot as a
  channel admin. "Force-join isn't working" → check channel-admin status first.

## Fail-open by design
- The membership check is tri-state: member / not-member / **inconclusive**
  (API error or bot-not-admin).
- Both the per-command gate and the periodic leave-sweep **fail open** on
  inconclusive: the gate allows the command, the sweep disconnects nobody.
- **Why:** a setup mistake (bot not admin, channel renamed, API blip) must never
  lock every user out of pairing or mass-disconnect live sessions.

## Private-chat only / identity
- The pairing console is private-chat only. In a private chat `chat.id == user id`,
  but in a group they differ.
- **Why:** if a group message were processed, `getChatMember(channel, groupId)`
  would fail → inconclusive → fail-open → force-join bypass, and a stray group
  tenant would be created. So non-private chats are ignored, and the membership
  check uses `message.from.id` (not `chat.id`).

## Eventual consistency
- Leave-detection is a periodic sweep (~5 min), not instant. A user who leaves
  lingers at most one interval. Across a server boot the boot-restore reconnect
  can briefly re-activate a leaver; the next sweep re-catches them. Acceptable —
  this is not a hard real-time guarantee.
