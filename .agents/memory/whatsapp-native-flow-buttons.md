---
name: WhatsApp native-flow button/interactive messages are unreliable
description: Why native-flow interactive button cards silently fail and must not back must-render content
---

Native-flow interactive messages (button cards built with `generateWAMessageFromContent` +
`relayMessage`, e.g. `quick_reply` / `cta_url` buttons, often wrapped in a `viewOnceMessage`
envelope) are an UNOFFICIAL WhatsApp feature. Many recipient WhatsApp builds **silently
drop** them: the message renders as nothing and the user sees no reply.

**The trap (why a try/catch fallback is NOT enough):** `relayMessage` resolves WITHOUT
throwing even when the recipient client drops the message. So a
`try { sendButtonMenu() } catch { sendText() }` fallback NEVER fires — there is no error to
catch, and you cannot detect non-render server-side. You get silent failure, not a fallback.

**Rule:** never put must-render content (a menu, a required prompt) behind a native-flow
button card. Use a plain text or image message, which always renders. If you want buttons as
a nice-to-have, send them IN ADDITION to a guaranteed text/image version — never as the sole
delivery, and never behind a throw-only fallback.

**Why:** the `.menu` command shipped as a button card and showed nothing on the live bot; no
error was ever logged because the relay "succeeded". Switching `.menu` to send the
text/image menu directly fixed it.

**Re-added by explicit user request (do NOT silently revert).** `.menu` now ships the
native-flow button menu again — a `single_select` list whose rows are the command
categories (tap → re-dispatches `<prefix>menu <category>`), plus an "ALL COMMANDS"
quick-reply and a channel `cta_url`. The user was shown the silent-drop risk and chose
button-only anyway. Mitigations that keep this safe: `.allmenu` (+ help/cmd/commands/
list/fullmenu) is a separate ALWAYS-renders text command, advertised in the menu footer
("no buttons? type .allmenu"). So do NOT treat the button `.menu` as a regression and
switch it back to text — if it renders blank for someone, the answer is `.allmenu`, not
removing the buttons. (Categories are chunked into sections of 10 for the row cap.)

**Decoding a tap (still useful — taps are real even if you don't send the buttons).** A
tapped button does NOT arrive as `conversation`/`extendedTextMessage`. Pull the selected id
from `buttonsResponseMessage.selectedButtonId` / `templateButtonReplyMessage.selectedId` /
`listResponseMessage.singleSelectReply.selectedRowId` / parse
`interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` (`.id`). The command
dispatcher's body extractor already reads these, so a tap whose id is a real command string
dispatches like the typed command (prefix + permission checks still apply).
