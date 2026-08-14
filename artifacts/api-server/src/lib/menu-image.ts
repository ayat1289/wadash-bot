import path from "path";
import fs from "fs";
import { logger } from "./logger";

const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();

export const MENU_IMAGE_DIR = path.resolve(workspaceRoot, "artifacts/api-server/data/menu-images");

/**
 * Persist a tenant's menu image to disk, overwriting any previous one, and
 * return the bare filename to store in `bot_config.menuImage`. The file's bytes
 * are read back as a Buffer at send time, so the extension is cosmetic.
 */
export async function saveMenuImage(tenantId: number, buffer: Buffer): Promise<string> {
  await fs.promises.mkdir(MENU_IMAGE_DIR, { recursive: true });
  const filename = `menu-${tenantId}.img`;
  await fs.promises.writeFile(path.join(MENU_IMAGE_DIR, filename), buffer);
  return filename;
}

/**
 * Read a stored menu image by its bare filename. Returns null when the value is
 * missing, contains a path separator (traversal guard), or the file is gone.
 */
export async function readMenuImage(filename: string | null | undefined): Promise<Buffer | null> {
  if (!filename) return null;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
  try {
    return await fs.promises.readFile(path.join(MENU_IMAGE_DIR, filename));
  } catch (err) {
    logger.warn({ err }, "menu image read failed");
    return null;
  }
}
