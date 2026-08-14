import type { Command, CommandContext } from "../types";

function ownerJid(num: string): string | null {
  const digits = (num ?? "").replace(/[^0-9]/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

async function forwardToOwner(ctx: CommandContext, label: string): Promise<void> {
  if (!ctx.text) {
    await ctx.reply(`Usage: *${ctx.prefix}${ctx.command} <your message>*`);
    return;
  }
  const jid = ownerJid(ctx.config.ownerNumber);
  if (!jid) {
    await ctx.reply("⚠️ The owner hasn't set a contact number yet, so this can't be delivered.");
    return;
  }
  const who = ctx.pushName ? `${ctx.pushName} (${ctx.senderNumber})` : ctx.senderNumber;
  await ctx.sock.sendMessage(jid, {
    text: `📨 *${label}*\n👤 From: ${who}\n💬 Chat: ${ctx.from}\n\n${ctx.text}`,
  });
  await ctx.reply(`✅ Your ${label.toLowerCase()} has been sent to the owner. Thank you!`);
}

export const supportCommands: Command[] = [
  {
    name: "support",
    aliases: ["contact"],
    category: "SUPPORT",
    desc: "How to contact the owner",
    handler: async (ctx) => {
      const num = ctx.config.ownerNumber || "not set";
      await ctx.reply(
        `🛟 *Support — ${ctx.config.botName}*\n\n` +
          `👤 Owner: ${ctx.config.ownerName}\n` +
          `📞 Contact: ${num}\n\n` +
          `Need help? Use:\n` +
          `• *${ctx.prefix}report <message>* — report a problem\n` +
          `• *${ctx.prefix}bug <message>* — report a bug\n` +
          `• *${ctx.prefix}suggestion <message>* — share an idea`,
      );
    },
  },
  { name: "report", category: "SUPPORT", desc: "Report something to the owner", handler: (ctx) => forwardToOwner(ctx, "Report") },
  { name: "bug", category: "SUPPORT", desc: "Report a bug to the owner", handler: (ctx) => forwardToOwner(ctx, "Bug Report") },
  {
    name: "suggestion",
    aliases: ["suggest"],
    category: "SUPPORT",
    desc: "Send a suggestion to the owner",
    handler: (ctx) => forwardToOwner(ctx, "Suggestion"),
  },
];
