import sharp from "sharp";
import type { Command, CommandContext } from "../types";
import { gemini, GEMINI_MODEL } from "@workspace/integrations-gemini";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server/image";
import { tryAcquire } from "../limiter";
import { logger } from "../../logger";

const MAX_PROMPT_CHARS = 8000;

const SYSTEM = {
  base: "You are a helpful, friendly assistant inside a WhatsApp chat. Keep answers concise, plain text, phone-friendly. Use *bold*/_italic_ sparingly; avoid markdown headings and code fences unless asked.",
  travel: "You are a travel expert. Give practical, budget-friendly travel tips.",
  fix: "Find the bug in the user's code/queries and give the corrected version with a short explanation.",
};

function chatWith(promptName: string, label: string): Command {
  return {
    name: promptName,
    category: "AI",
    desc: `${label}`,
    handler: async (ctx) => {
      const prompt = (ctx.text.trim() || ctx.quotedText?.trim() || "").slice(0, MAX_PROMPT_CHARS);
      if (!prompt) return ctx.reply(`Usage: *${ctx.prefix}${promptName} <text or reply>*`);
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🤖");
        const sys = SYSTEM[promptName as keyof typeof SYSTEM];
        const completion = await gemini.chat.completions.create({
          model: GEMINI_MODEL,
          max_tokens: 2048,
          messages: [
            { role: "system", content: sys ?? SYSTEM.base },
            { role: "user", content: prompt },
          ],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        if (!answer) throw new Error("empty AI response");
        await ctx.reply(answer.slice(0, 4000));
      } catch (err) {
        logger.warn({ err, cmd: promptName }, "AI chat failed");
        await ctx.reply("❌ The AI couldn't answer right now. Check the API key, then try again.");
      } finally {
        slot.release();
      }
    },
  };
}

// per-user memory (in-memory)
const memory = new Map<string, string[]>();
function memKey(ctx: CommandContext): string {
  return `${ctx.tenantId}:${ctx.sender}`;
}

export const ai2Commands: Command[] = [
  // Personas
  chatWith("agent", "Versatile AI assistant"),
  chatWith("travel", "Travel tips"),
  // Code / text tools
  chatWith("fix", "Fix the bug in the reply text"),
  {
    name: "aimem",
    category: "AI",
    desc: "Ask the AI with memory of this chat",
    handler: async (ctx) => {
      const prompt = (ctx.text.trim() || ctx.quotedText?.trim() || "").slice(0, MAX_PROMPT_CHARS);
      if (!prompt) return ctx.reply(`Usage: *${ctx.prefix}aimem <question>*`);
      const k = memKey(ctx);
      const hist = memory.get(k) ?? [];
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🧠");
        const completion = await gemini.chat.completions.create({
          model: GEMINI_MODEL,
          max_tokens: 2048,
          messages: [
            { role: "system", content: SYSTEM.base },
            ...hist.slice(-6).map((m) => ({ role: "user" as const, content: m })),
            { role: "user", content: prompt },
          ],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        hist.push(prompt);
        if (answer) hist.push(answer);
        memory.set(k, hist.slice(-20));
        await ctx.reply((answer ?? "❌ No response.").slice(0, 4000));
      } catch (err) {
        logger.warn({ err }, "aimem failed");
        await ctx.reply("❌ The AI couldn't answer right now. Check the API key.");
      } finally {
        slot.release();
      }
    },
  },
  {
    name: "aireset",
    category: "AI",
    desc: "Clear the AI memory for this chat",
    handler: async (ctx) => {
      memory.delete(memKey(ctx));
      await ctx.reply("🧠 Memory cleared.");
    },
  },
  {
    name: "aisticker",
    category: "AI",
    desc: "Generate a sticker from a prompt",
    handler: async (ctx) => {
      const prompt = ctx.text.trim();
      if (!prompt) return ctx.reply(`Usage: *${ctx.prefix}aisticker <prompt>*`);
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🎨");
        const img = await generateImageBuffer(`Sticker style. ${prompt}`);
        const webp = await sharp(img, { limitInputPixels: 16_777_216 })
          .resize(512, 512, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .webp({ quality: 90 })
          .toBuffer();
        await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
        await ctx.react("✅");
      } catch (err) {
        logger.warn({ err }, "aisticker failed");
        await ctx.reply("❌ Couldn't generate that sticker right now.");
      } finally {
        slot.release();
      }
    },
  },
];