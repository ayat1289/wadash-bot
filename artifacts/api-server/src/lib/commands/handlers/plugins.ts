import { mkdir, writeFile, readdir, unlink } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { randomUUID } from "crypto";
import type { Command, CommandContext } from "../types";
import { register, commands } from "../registry";
import { logger } from "../../logger";

// ---------------------------------------------------------------------------
// Plugin manager — lets the owner install/remove JS plugins at runtime.
//
// A plugin is a single JavaScript module that exports a `commands` array (the
// same shape as `handlers/*.ts`). `.plugin install <raw-url>` fetches the file,
// saves it under `<cwd>/plugins/`, dynamically imports it, and registers every
// exported command immediately. No restart needed. Installed plugins are also
// picked up again after a restart (loadPlugins is called at startup).
//
// Example plugin file:
//
//   export const commands = [
//     {
//       name: "hello",
//       category: "TOOLS",
//       desc: "Say hello",
//       handler: async (ctx) => ctx.reply("Hello!"),
//     },
//   ];
// ---------------------------------------------------------------------------

const PLUGINS_DIR = path.resolve(process.cwd(), "plugins");

function isCommandLike(c: unknown): c is Command {
  return (
    typeof c === "object" &&
    c !== null &&
    typeof (c as Command).name === "string" &&
    typeof (c as Command).handler === "function"
  );
}

function nameFromUrl(url: string): string {
  const clean = url.split(/[?#]/)[0].split("/").pop() ?? "";
  const base = clean.replace(/\.[a-z0-9]+$/i, "") || "plugin";
  return base.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function loadPluginFile(file: string, tenantId: number): Promise<{ loaded: string[]; error?: string }> {
  const url = pathToFileURL(file).href + `?t=${Date.now()}`;
  try {
    const mod = (await import(url)) as Record<string, unknown>;
    const def = mod.default as Record<string, unknown> | undefined;
    const raw = (mod.commands ?? def?.commands ?? []) as unknown[];
    const cmds = raw.filter(isCommandLike);
    if (!cmds.length) {
      return { loaded: [], error: "Plugin exports no valid `commands` array." };
    }
    register(cmds);
    return { loaded: cmds.map((c) => c.name) };
  } catch (err) {
    logger.warn({ err, file, tenantId }, "Plugin load failed");
    return { loaded: [], error: String((err as Error)?.message ?? err) };
  }
}

async function installedFiles(): Promise<string[]> {
  try {
    const entries = await readdir(PLUGINS_DIR);
    return entries.filter((e) => e.endsWith(".js") || e.endsWith(".mjs"));
  } catch {
    return [];
  }
}

/**
 * Load all plugins from the plugins directory. Called at startup so plugins
 * installed in a previous session keep working after a restart.
 */
export async function loadPlugins(tenantId: number = 1): Promise<void> {
  const files = await installedFiles();
  for (const f of files) {
    const res = await loadPluginFile(path.join(PLUGINS_DIR, f), tenantId);
    if (res.error) logger.warn({ file: f, err: res.error }, "Plugin skipped at startup");
    else logger.info({ file: f, commands: res.loaded }, "Plugin loaded");
  }
}

export const pluginCommands: Command[] = [
  {
    name: "jid",
    category: "TOOLS",
    desc: "Get the JID of this chat or a mentioned/replied user",
    handler: async (ctx: CommandContext) => {
      const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
      const quoted = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      const num = ctx.text.replace(/[^0-9]/g, "");

      if (mentioned.length) {
        return ctx.reply(`👤 *${mentioned[0]}*`);
      }
      if (quoted) {
        return ctx.reply(`👤 *${quoted}*`);
      }
      if (num) {
        return ctx.reply(`👤 *${num}@s.whatsapp.net*`);
      }
      if (ctx.isGroup) {
        return ctx.reply(
          `👥 *Group JID:*\n\`${ctx.from}\`\n\n_Use with \`${ctx.prefix}add\` to set this group as an Alinks target._`,
        );
      }
      return ctx.reply(`👤 *Your JID:*\n\`${ctx.sender}\``);
    },
  },
  {
    name: "plugin",
    aliases: ["installplugin", "addplugin"],
    category: "OWNER",
    desc: "Install/remove a plugin (owner)",
    ownerOnly: true,
    handler: async (ctx: CommandContext) => {
      const [sub, ...rest] = ctx.text.trim().split(/\s+/);
      const s = (sub ?? "").toLowerCase();
      const arg = rest.join(" ").trim();

      if (s === "install" || s === "add" || s === "i") {
        if (!/^https?:\/\//.test(arg)) {
          return ctx.reply(
            `Usage: *${ctx.prefix}plugin install <raw-plugin-url>*\n\n` +
              `Works with raw gist links (https://gist.github.com/.../raw) or any `.trim() +
              `plain JS file URL. The plugin file must export a \`commands\` array.`,
          );
        }
        await ctx.react("⏳");
        try {
          const res = await fetch(arg);
          if (!res.ok) return ctx.reply(`❌ Download failed (HTTP ${res.status}).`);
          const code = await res.text();
          if (!code.trim()) return ctx.reply("❌ The plugin file is empty.");

          await mkdir(PLUGINS_DIR, { recursive: true });
          const name = nameFromUrl(arg) + "-" + randomUUID().slice(0, 6);
          const file = path.join(PLUGINS_DIR, `${name}.mjs`);
          await writeFile(file, code, "utf8");

          const result = await loadPluginFile(file, ctx.tenantId);
          if (result.error) {
            await unlink(file).catch(() => {});
            return ctx.reply(`❌ Plugin install failed:\n${result.error}`);
          }
          return ctx.reply(
            `✅ Plugin *${name}* installed and loaded.\n` +
              `Commands: ${result.loaded.map((c) => `\`${c}\``).join(", ")}`,
          );
        } catch (err) {
          logger.warn({ err, tenantId: ctx.tenantId }, "Plugin install failed");
          return ctx.reply("❌ Couldn't install the plugin. Check the URL and try again.");
        }
      }

      if (s === "remove" || s === "del" || s === "delete" || s === "rm" || s === "uninstall") {
        const files = await installedFiles();
        const target = files.find((f) => f === arg || f.startsWith(arg));
        if (!target) {
          return ctx.reply(
            files.length
              ? `📦 *Installed plugins:*\n${files.map((f) => `› ${f}`).join("\n")}\n\nRemove with: *${ctx.prefix}plugin remove <name>*`
              : "📦 No plugins installed.",
          );
        }
        await unlink(path.join(PLUGINS_DIR, target)).catch(() => {});
        return ctx.reply(`🗑️ Removed plugin *${target}*. It's unloaded after the next restart.`);
      }

      if (s === "reload") {
        for (const f of await installedFiles()) {
          await loadPluginFile(path.join(PLUGINS_DIR, f), ctx.tenantId).catch(() => {});
        }
        return ctx.reply("🔄 Plugins reloaded.");
      }

      const files = await installedFiles();
      return ctx.reply(
        `*Plugin Manager*\n\n` +
          (files.length
            ? `📦 *Installed:*\n${files.map((f) => `› ${f}`).join("\n")}\n\n`
            : `📦 *Installed:* none\n\n`) +
          `› *${ctx.prefix}plugin install <url>* — install from a raw/gist URL\n` +
          `› *${ctx.prefix}plugin remove <name>* — remove a plugin\n` +
          `› *${ctx.prefix}plugin reload* — reload all plugins\n\n` +
          `_The plugin file must export a \`commands\` array (same shape as the bot's handlers)._`,
      );
    },
  },
];
