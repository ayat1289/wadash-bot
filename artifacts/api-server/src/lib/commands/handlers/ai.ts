import type { Command } from "../types";
import { gemini, GEMINI_MODEL } from "@workspace/integrations-gemini";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server/image";
import { tryAcquire } from "../limiter";
import { logger } from "../../logger";

const MAX_PROMPT_CHARS = 4000;

function systemPrompt(botName: string): string {
  return (
    `You are ${botName}, a helpful, friendly assistant replying inside a WhatsApp chat. ` +
    `Keep answers concise and easy to read on a phone. Plain text is best; WhatsApp ` +
    `formatting (*bold*, _italic_) is fine, but avoid markdown headings, tables, and ` +
    `code fences unless the user explicitly asks for code.`
  );
}

function chatCommand(
  name: string,
  aliases: string[] | undefined,
  label: string,
): Command {
  return {
    name,
    aliases,
    category: "AI",
    desc: `Ask ${label}`,
    handler: async (ctx) => {
      const prompt = (ctx.text.trim() || ctx.quotedText?.trim() || "").slice(
        0,
        MAX_PROMPT_CHARS,
      );
      if (!prompt) {
        return ctx.reply(
          `Usage: *${ctx.prefix}${name} <your question>*\n` +
            `Example: *${ctx.prefix}${name} explain photosynthesis simply*`,
        );
      }
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) {
        await ctx.reply(slot.reason);
        return;
      }
      try {
        await ctx.react("🤖");
        const completion = await gemini.chat.completions.create({
          model: GEMINI_MODEL,
          max_tokens: 8192,
          messages: [
            { role: "system", content: systemPrompt(ctx.config.botName) },
            { role: "user", content: prompt },
          ],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        if (!answer) throw new Error("empty AI response");
        await ctx.reply(answer);
      } catch (err) {
        logger.warn({ err, model: GEMINI_MODEL }, "AI chat failed");
        await ctx.reply("❌ The AI couldn't answer right now. Please try again in a moment.");
      } finally {
        slot.release();
      }
    },
  };
}

function imageCommand(name: string, aliases: string[] | undefined): Command {
  return {
    name,
    aliases,
    category: "AI",
    desc: "Generate an image from a text description",
    handler: async (ctx) => {
      const prompt = (ctx.text.trim() || ctx.quotedText?.trim() || "").slice(
        0,
        MAX_PROMPT_CHARS,
      );
      if (!prompt) {
        return ctx.reply(
          `Usage: *${ctx.prefix}${name} <description>*\n` +
            `Example: *${ctx.prefix}${name} a cat astronaut on the moon, digital art*`,
        );
      }
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
      if (!slot.ok) {
        await ctx.reply(slot.reason);
        return;
      }
      try {
        await ctx.react("🎨");
        const buffer = await generateImageBuffer(prompt, "1024x1024");
        if (!buffer.length) throw new Error("empty image");
        await ctx.sock.sendMessage(
          ctx.from,
          { image: buffer, caption: `🎨 ${prompt}` },
          { quoted: ctx.msg },
        );
      } catch (err) {
        logger.warn({ err }, "AI image generation failed");
        await ctx.reply("❌ Couldn't generate that image right now. Please try again in a moment.");
      } finally {
        slot.release();
      }
    },
  };
}

export const aiCommands: Command[] = [
  chatCommand("gpt", ["gpt4", "chatgpt"], "ChatGPT"),
  chatCommand("gemini", ["bard"], "Gemini"),
  chatCommand("claude", undefined, "Claude"),
  chatCommand("deepseek", undefined, "DeepSeek"),
  chatCommand("blackbox", undefined, "Blackbox AI"),
  chatCommand("llama", undefined, "Llama"),
  chatCommand("ai", undefined, "the AI"),
  imageCommand("imagine", ["dalle", "aiimg"]),
];
