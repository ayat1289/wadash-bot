import { spawn } from "node:child_process";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child process, capture stdout/stderr, and enforce a hard timeout
 * (SIGKILL). Output is bounded to avoid unbounded memory growth on chatty
 * tools. Never rejects on a non-zero exit — inspect `code` instead.
 */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxStdoutBytes?: number } = {},
): Promise<ProcResult> {
  const { timeoutMs = 120_000, maxStdoutBytes = 8_000_000 } = opts;
  return new Promise((resolve, reject) => {
    // `detached` puts the child in its own process group so we can SIGKILL the
    // whole tree on timeout (e.g. yt-dlp's ffmpeg grandchild), not just the
    // direct child.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > maxStdoutBytes) stdout = stdout.slice(-maxStdoutBytes);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
