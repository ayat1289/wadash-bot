import { downloadMediaMessage } from "@whiskeysockets/baileys";
import sharp from "sharp";
import type { Command, CommandContext } from "../types";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { speechToText } from "@workspace/integrations-openai-ai-server/audio";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server/image";
import { tryAcquire } from "../limiter";
import { hasMedia, downloadMedia } from "../media-utils";
import { logger } from "../../logger";

const pdfParse = (mod: typeof import("pdf-parse")) => mod.default ?? mod;

async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const mod = await import("pdf-parse");
    const result = await pdfParse(mod)(buf);
    return result?.text ?? "";
  } catch (err) {
    logger.warn({ err }, "pdf-parse failed");
    return "";
  }
}

const MAX_PROMPT_CHARS = 8000;

const SYSTEM = {
  base: "You are a helpful, friendly assistant inside a WhatsApp chat. Keep answers concise, plain text, phone-friendly. Use *bold*/_italic_ sparingly; avoid markdown headings and code fences unless asked.",
  teacher: "You are a patient, friendly teacher. Explain concepts clearly with everyday examples and simple steps.",
  programmer: "You are an expert programmer. Give concise, correct code and short explanations.",
  doctor: "You are a health-information assistant. Give general info only and always advise seeing a real doctor. Not medical advice.",
  lawyer: "You are a legal-information assistant. Give general info and always recommend a licensed attorney. Not legal advice.",
  chef: "You are a chef. Give practical cooking tips and simple recipes.",
  fitness: "You are a fitness coach. Give safe workout and nutrition advice.",
  travel: "You are a travel expert. Give practical, budget-friendly travel tips.",
  business: "You are a business consultant. Give practical business and money advice.",
  explain: "Explain the user's topic clearly and simply for a beginner.",
  explaincode: "Explain the user's code line by line, simply, noting what each part does.",
  fix: "Find the bug in the user's code/queries and give the corrected version with a short explanation.",
  rewrite: "Rewrite the user's text to be clearer, more natural, and well-structured while keeping the same meaning.",
  debug: "Act as a debugging assistant. Identify likely causes of the reported error and give step-by-step fixes.",
  optimize: "Optimize the user's code: suggest improvements for speed, readability, and safety with before/after examples.",
  generatecode: "Write the code the user asks for. Include a short usage note.",
  moderate: "Review the user's message for abusive content. Reply briefly: SAFE or flag the issue and suggest a kinder rewrite.",
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
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
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
  chatWith("teacher", "Explain like a teacher"),
  chatWith("programmer", "Code expert"),
  chatWith("doctor", "Health info with disclaimer"),
  chatWith("lawyer", "Legal info with disclaimer"),
  chatWith("chef", "Cooking tips and recipes"),
  chatWith("fitness", "Workout and nutrition advice"),
  chatWith("travel", "Travel tips"),
  chatWith("business", "Business advice"),
  // Code / text tools
  chatWith("explain", "Explain anything simply"),
  chatWith("explaincode", "Explain the reply code"),
  chatWith("fix", "Fix the bug in the reply text"),
  chatWith("rewrite", "Rewrite the reply text clearly"),
  chatWith("debug", "Debug the reported issue"),
  chatWith("optimize", "Optimize the code"),
  chatWith("generatecode", "Generate code"),
  chatWith("moderate", "Review message for abusive content"),
  {
    name: "aitranslate",
    category: "AI",
    desc: "Translate text to another language",
    handler: async (ctx) => {
      const [lang, ...rest] = ctx.text.trim().split(/\s+/);
      const prompt = rest.join(" ") || ctx.quotedText?.trim() || "";
      if (!lang || !prompt) return ctx.reply(`Usage: *${ctx.prefix}aitranslate <target-language> <text or reply>*`);
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🈯");
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 2048,
          messages: [{ role: "system", content: `Translate the user text into ${lang}. Reply with ONLY the translation.` }, { role: "user", content: prompt }],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply(answer ? answer.slice(0, 3000) : "❌ No translation returned.");
      } finally {
        slot.release();
      }
    },
  },
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
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
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
    name: "describe",
    category: "AI",
    desc: "Describe an image with AI",
    handler: async (ctx) => {
      if (!hasMedia(ctx, "image")) return ctx.reply("🖼️ Send or reply to an *image* with `.describe`.");
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("👁️");
        const buf = await downloadMedia(ctx, "image");
        if (!buf) return ctx.reply("❌ Couldn't read the image.");
        const base64 = buf.toString("base64");
        const prompt = ctx.text.trim() || "Describe this image in detail.";
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 1500,
          messages: [
            { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }] },
          ],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply((answer ?? "❌ No description returned.").slice(0, 3500));
      } catch (err) {
        logger.warn({ err }, "describe failed");
        await ctx.reply("❌ Couldn't analyze the image right now.");
      } finally {
        slot.release();
      }
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
  {
    name: "transcribe",
    category: "AI",
    desc: "Transcribe a voice note or audio",
    handler: async (ctx) => {
      const m = ctx.msg.message;
      const media = m?.audioMessage ?? m?.videoMessage ?? m?.documentMessage ?? m?.ptvMessage;
      if (!media) return ctx.reply("🎤 Send a voice note or audio to transcribe.");
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🎤");
        const buf = (await downloadMediaMessage(ctx.msg, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage })) as Buffer;
        const text = await speechToText(buf);
        await ctx.reply((text?.trim() || "❌ Couldn't hear audio.").slice(0, 3500));
      } catch (err) {
        logger.warn({ err }, "transcribe failed");
        await ctx.reply("❌ Transcription failed right now.");
      } finally {
        slot.release();
      }
    },
  },
  {
    name: "translateaudio",
    category: "AI",
    desc: "Transcribe + translate a voice note to English",
    handler: async (ctx) => {
      const m = ctx.msg.message;
      const media = m?.audioMessage ?? m?.videoMessage ?? m?.ptvMessage;
      if (!media) return ctx.reply("🎤 Send a voice note or audio to translate.");
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🎤");
        const buf = (await downloadMediaMessage(ctx.msg, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage })) as Buffer;
        const text = await speechToText(buf);
        if (!text?.trim()) return ctx.reply("❌ Couldn't hear audio.");
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 1500,
          messages: [{ role: "system", content: "Translate the user's message to English. Reply with the translation only." }, { role: "user", content: text }],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply(`📝 *Transcription:*\n${text}\n\n🌐 *Translation:*\n${answer ?? "n/a"}`.slice(0, 3500));
      } catch (err) {
        logger.warn({ err }, "translateaudio failed");
        await ctx.reply("❌ Translation failed right now.");
      } finally {
        slot.release();
      }
    },
  },
  {
    name: "summarizeaudio",
    category: "AI",
    desc: "Summarize a voice note or audio",
    handler: async (ctx) => {
      const m = ctx.msg.message;
      const media = m?.audioMessage ?? m?.videoMessage ?? m?.ptvMessage;
      if (!media) return ctx.reply("🎤 Send a voice note or audio to summarize.");
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🎤");
        const buf = (await downloadMediaMessage(ctx.msg, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage })) as Buffer;
        const text = await speechToText(buf);
        if (!text?.trim()) return ctx.reply("❌ Couldn't hear audio.");
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 1500,
          messages: [{ role: "system", content: "Summarize the user's message into a few clear bullet points." }, { role: "user", content: text }],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply(`📊 *Summary:*\n${answer ?? "n/a"}`.slice(0, 3500));
      } catch (err) {
        logger.warn({ err }, "summarizeaudio failed");
        await ctx.reply("❌ Summarization failed right now.");
      } finally {
        slot.release();
      }
    },
  },
  {
    name: "askpdf",
    category: "AI",
    desc: "Ask a question about a PDF",
    handler: async (ctx) => {
      if (!hasMedia(ctx, "document")) return ctx.reply("📄 Send or reply to a *PDF* with `.askpdf <question>`");
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("📄");
        const buf = (await downloadMediaMessage(ctx.msg, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage })) as Buffer;
        const pdfText = await extractPdfText(buf);
        const question = ctx.text.trim() || "Summarize this PDF";
        if (!pdfText.trim()) return ctx.reply("❌ Couldn't read the PDF (it may be scanned images).");
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 1500,
          messages: [{ role: "system", content: "Answer the user's question using ONLY the provided PDF text." }, { role: "user", content: `PDF TEXT:\n${pdfText.slice(0, 12000)}\n\nQUESTION: ${question}` }],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply((answer ?? "❌ No answer returned.").slice(0, 3500));
      } catch (err) {
        logger.warn({ err }, "askpdf failed");
        await ctx.reply("❌ Couldn't process the PDF right now.");
      } finally {
        slot.release();
      }
    },
  },
  {
    name: "summarizepdf",
    category: "AI",
    desc: "Summarize a PDF",
    handler: async (ctx) => {
      if (!hasMedia(ctx, "document")) return ctx.reply("📄 Send or reply to a *PDF* with `.summarizepdf`");
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("📄");
        const buf = (await downloadMediaMessage(ctx.msg, "buffer", {}, { logger, reuploadRequest: ctx.sock.updateMediaMessage })) as Buffer;
        const pdfText = await extractPdfText(buf);
        if (!pdfText.trim()) return ctx.reply("❌ Couldn't read the PDF (it may be scanned images).");
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 1500,
          messages: [{ role: "system", content: "Summarize the provided PDF text into clear bullet points." }, { role: "user", content: pdfText.slice(0, 12000) }],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply(`📊 *PDF summary:*\n${answer ?? "n/a"}`.slice(0, 3500));
      } catch (err) {
        logger.warn({ err }, "summarizepdf failed");
        await ctx.reply("❌ Couldn't process the PDF right now.");
      } finally {
        slot.release();
      }
    },
  },
  {
    name: "aisearch",
    category: "AI",
    desc: "Answer with AI on any topic",
    handler: async (ctx) => {
      const prompt = (ctx.text.trim() || ctx.quotedText?.trim() || "").slice(0, MAX_PROMPT_CHARS);
      if (!prompt) return ctx.reply(`Usage: *${ctx.prefix}aisearch <topic>*`);
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`);
      if (!slot.ok) return ctx.reply(slot.reason);
      try {
        await ctx.react("🔎");
        const completion = await openrouter.chat.completions.create({
          model: "openai/gpt-4o-mini",
          max_tokens: 2048,
          messages: [{ role: "system", content: `${SYSTEM.base} Answer as if responding to a web search; be accurate and cite sources only if you're sure.` }, { role: "user", content: prompt }],
        });
        const answer = completion.choices[0]?.message?.content?.trim();
        await ctx.reply((answer ?? "❌ No answer returned.").slice(0, 4000));
      } catch (err) {
        logger.warn({ err }, "aisearch failed");
        await ctx.reply("❌ The AI couldn't answer right now.");
      } finally {
        slot.release();
      }
    },
  },
];