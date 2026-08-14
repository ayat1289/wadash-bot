import { logger } from "./logger";
import { getTenantSocket } from "./whatsapp";
import { listDueTasks, markTaskStatus } from "./scheduled-tasks-store";

// Single-process poller for due scheduled tasks (reminders + scheduled group
// open/close). Mirrors the status scheduler: a 30s setInterval over a DB table.
// A task whose tenant is currently offline is simply left pending and retried
// on the next tick (it fires late once the tenant reconnects).

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startTaskScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void processDueTasks();
  }, 30_000);
}

async function processDueTasks(): Promise<void> {
  // In-flight guard: a slow send must not let the next tick start a second pass
  // over the same still-pending rows (which would double-deliver before the
  // first pass marks them done).
  if (running) return;
  running = true;
  try {
    await runDueTasks();
  } finally {
    running = false;
  }
}

async function runDueTasks(): Promise<void> {
  let due;
  try {
    due = await listDueTasks(new Date());
  } catch (err) {
    logger.error({ err }, "Task scheduler query failed");
    return;
  }

  for (const task of due) {
    const sock = getTenantSocket(task.tenantId);
    if (!sock) continue; // tenant offline — leave pending, retry next tick

    try {
      if (task.kind === "reminder") {
        await sock.sendMessage(task.targetJid, { text: `⏰ *Reminder*\n\n${task.body ?? ""}` });
      } else if (task.kind === "group_open") {
        await sock.groupSettingUpdate(task.targetJid, "not_announcement");
        await sock.sendMessage(task.targetJid, { text: "🔓 Group opened (scheduled)." });
      } else if (task.kind === "group_close") {
        await sock.groupSettingUpdate(task.targetJid, "announcement");
        await sock.sendMessage(task.targetJid, { text: "🔒 Group closed (scheduled)." });
      }
      await markTaskStatus(task.id, "done");
    } catch (err) {
      logger.error({ err, taskId: task.id, kind: task.kind }, "Scheduled task failed");
      await markTaskStatus(task.id, "failed");
    }
  }
}
