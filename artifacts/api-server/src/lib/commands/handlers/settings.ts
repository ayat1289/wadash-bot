import type { Command } from "../types";
import { setConfig } from "../../config";
import { downloadMedia, hasMedia } from "../media-utils";
import { saveMenuImage } from "../../menu-image";

const TOGGLE_KEYS: Record<string, string> = {
  autoread: "autoread",
  antidelete: "antidelete",
  antiviewonce: "antiviewonce",
  alwaysonline: "alwaysonline",
  anticall: "anticall",
  autotyping: "autotyping",
  antibug: "antibug",
  autoreact: "autoreact",
};

function toggleCommand(name: string, key: string, label: string): Command {
  return {
    name,
    category: "SETTINGS",
    desc: `Toggle ${label}`,
    ownerOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "on" && val !== "off") return ctx.reply(`Usage: *${ctx.prefix}${name} on/off*`);
      await setConfig(key, val === "on" ? "true" : "false", ctx.tenantId);
      await ctx.reply(`⚙️ ${label} is now *${val.toUpperCase()}*`);
    },
  };
}

export const settingsCommands: Command[] = [
  {
    name: "setprefix",
    category: "SETTINGS",
    desc: "Change command prefix",
    ownerOnly: true,
    handler: async (ctx) => {
      const np = ctx.text.trim();
      if (!np || np.length > 3) return ctx.reply(`Usage: *${ctx.prefix}setprefix <symbol>* (1-3 chars)`);
      await setConfig("prefix", np, ctx.tenantId);
      await ctx.reply(`✅ Prefix changed to *${np}*\nExample: ${np}menu`);
    },
  },
  {
    name: "setbotname",
    category: "SETTINGS",
    desc: "Change bot display name",
    ownerOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}setbotname <name>*`);
      await setConfig("botName", ctx.text.trim(), ctx.tenantId);
      await ctx.reply(`✅ Bot name set to *${ctx.text.trim()}*`);
    },
  },
  {
    name: "setowner",
    category: "SETTINGS",
    desc: "Set owner name & number",
    ownerOnly: true,
    handler: async (ctx) => {
      const num = ctx.text.replace(/[^0-9]/g, "");
      if (!num) return ctx.reply(`Usage: *${ctx.prefix}setowner <number>*`);
      await setConfig("ownerNumber", num, ctx.tenantId);
      await ctx.reply(`✅ Owner number set to *${num}*`);
    },
  },
  {
    name: "setownername",
    category: "SETTINGS",
    desc: "Set owner display name",
    ownerOnly: true,
    handler: async (ctx) => {
      if (!ctx.text) return ctx.reply(`Usage: *${ctx.prefix}setownername <name>*`);
      await setConfig("ownerName", ctx.text.trim(), ctx.tenantId);
      await ctx.reply(`✅ Owner name set to *${ctx.text.trim()}*`);
    },
  },
  {
    name: "mode",
    aliases: ["setmode"],
    category: "SETTINGS",
    desc: "Switch public/private mode",
    ownerOnly: true,
    handler: async (ctx) => {
      const val = ctx.text.toLowerCase().trim();
      if (val !== "public" && val !== "private") return ctx.reply(`Usage: *${ctx.prefix}mode public/private*`);
      await setConfig("mode", val, ctx.tenantId);
      await ctx.reply(`✅ Bot mode set to *${val}*`);
    },
  },
  {
    name: "setmenuimage",
    category: "SETTINGS",
    desc: "Set menu image (send/reply an image)",
    ownerOnly: true,
    handler: async (ctx) => {
      if (!hasMedia(ctx, "image")) {
        return ctx.reply(
          `Send an image with the caption *${ctx.prefix}setmenuimage*, or reply to an image with *${ctx.prefix}setmenuimage*.`,
        );
      }
      const buffer = await downloadMedia(ctx, "image");
      if (!buffer || !buffer.length) return ctx.reply("❌ Couldn't read that image. Try again.");
      const filename = await saveMenuImage(ctx.tenantId, buffer);
      await setConfig("menuImage", filename, ctx.tenantId);
      await ctx.reply(`✅ Menu image updated.`);
    },
  },
  ...Object.entries(TOGGLE_KEYS).map(([name, key]) => toggleCommand(name, key, name)),
];
