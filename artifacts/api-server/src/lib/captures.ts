import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { db, capturesTable, type InsertCapture } from "@workspace/db";
import { logger } from "./logger";

const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();

export const CAPTURES_DIR = path.resolve(workspaceRoot, "artifacts/api-server/data/captures");

function ext(mimetype: string | undefined, kind: string): string {
  if (mimetype?.includes("jpeg") || mimetype?.includes("jpg")) return "jpg";
  if (mimetype?.includes("png")) return "png";
  if (mimetype?.includes("webp")) return "webp";
  if (mimetype?.includes("gif")) return "gif";
  if (mimetype?.includes("mp4")) return "mp4";
  if (mimetype?.includes("3gpp")) return "3gp";
  if (mimetype?.includes("ogg") || mimetype?.includes("opus")) return "ogg";
  if (mimetype?.includes("mpeg") || mimetype?.includes("mp3")) return "mp3";
  if (mimetype?.includes("aac")) return "aac";
  if (kind === "image") return "jpg";
  if (kind === "video") return "mp4";
  if (kind === "audio") return "ogg";
  return "bin";
}

/** Persist a media buffer to the captures dir, returning its relative filename. */
export async function saveCaptureMedia(
  buffer: Buffer,
  contentType: string,
  mimetype: string | undefined,
): Promise<string> {
  await fs.promises.mkdir(CAPTURES_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext(mimetype, contentType)}`;
  await fs.promises.writeFile(path.join(CAPTURES_DIR, filename), buffer);
  return filename;
}

/** Absolute path to a stored capture media file (or null if no filename). */
export function captureMediaPath(filename: string | null | undefined): string | null {
  if (!filename) return null;
  // Guard against path traversal — only allow a bare filename.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
  return path.join(CAPTURES_DIR, filename);
}

/** Insert a capture row. Never throws — capture persistence is best-effort. */
export async function recordCapture(row: InsertCapture): Promise<void> {
  try {
    await db.insert(capturesTable).values(row);
  } catch (err) {
    logger.warn({ err }, "Failed to persist capture");
  }
}
