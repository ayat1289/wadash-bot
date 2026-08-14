import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, CommandContext } from "../types";
import { downloadMedia, hasMedia } from "../media-utils";
import { runProcess } from "../proc";
import { getFfmpegPath } from "../ffmpeg";
import { tryAcquire } from "../limiter";
import { logger } from "../../logger";

const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20MB of source audio

/**
 * ffmpeg audio-filter chains. Pitch-shifting effects prefix with
 * `aresample=44100` so the `asetrate` factor is independent of the source
 * sample rate, then resample back to 44100 to keep normal playback speed.
 */
const EFFECTS: Record<string, string> = {
  bass: "bass=g=20",
  blown: "acrusher=level_in=8:level_out=18:bits=8:mode=log:aa=1",
  deep: "aresample=44100,asetrate=44100*0.82,aresample=44100",
  earrape: "volume=12dB,acrusher=level_in=4:level_out=10:bits=8:mode=log:aa=1",
  fast: "atempo=1.5",
  fat: "aresample=44100,asetrate=44100*0.9,aresample=44100,bass=g=8",
  nightcore: "aresample=44100,asetrate=44100*1.25,aresample=44100",
  reverse: "areverse",
  robot: "flanger=delay=10:depth=5,aecho=0.8:0.8:40:0.6",
  slow: "atempo=0.8",
  smooth: "atempo=0.9,bass=g=4,treble=g=-3",
  chipmunk: "aresample=44100,asetrate=44100*1.4,aresample=44100",
  demon: "aresample=44100,asetrate=44100*0.65,aresample=44100",
  baby: "aresample=44100,asetrate=44100*1.55,aresample=44100",
};

async function applyEffect(input: Buffer, filter: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "afx-"));
  const inPath = join(dir, "in");
  const outPath = join(dir, "out.mp3");
  try {
    await writeFile(inPath, input);
    const { code, stderr } = await runProcess(
      getFfmpegPath(),
      ["-y", "-i", inPath, "-af", filter, "-ac", "2", "-b:a", "128k", outPath],
      { timeoutMs: 90_000 },
    );
    if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(-200)}`);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function effectCommand(name: string, filter: string): Command {
  return {
    name,
    category: "AUDIO",
    desc: `Apply the ${name} effect to an audio/voice note`,
    handler: async (ctx: CommandContext) => {
      if (!hasMedia(ctx, "audio")) {
        await ctx.reply(
          `🎧 Reply to an audio or voice note with *${ctx.prefix}${name}* to apply the effect.`,
        );
        return;
      }
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
      if (!slot.ok) {
        await ctx.reply(slot.reason);
        return;
      }
      try {
        await ctx.react("⏳");
        const input = await downloadMedia(ctx, "audio");
        if (!input || !input.length) throw new Error("no audio downloaded");
        if (input.length > MAX_INPUT_BYTES) {
          await ctx.reply("❌ That audio is too large (max ~20MB).");
          return;
        }
        const output = await applyEffect(input, filter);
        await ctx.sock.sendMessage(
          ctx.from,
          { audio: output, mimetype: "audio/mpeg", fileName: `${name}.mp3` },
          { quoted: ctx.msg },
        );
        await ctx.react("✅");
      } catch (err) {
        logger.warn({ err, cmd: name }, "audio effect failed");
        await ctx.reply("❌ Couldn't process that audio. Try a shorter clip.");
      } finally {
        slot.release();
      }
    },
  };
}

export const audioCommands: Command[] = Object.entries(EFFECTS).map(
  ([name, filter]) => effectCommand(name, filter),
);
