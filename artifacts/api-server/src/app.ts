import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { logger } from "./lib/logger";
import { ensureLegacyTenant } from "@workspace/db";
import { migrateLegacyAuthDir, bootRestoreTenants } from "./lib/whatsapp";
import { startStatusScheduler } from "./routes/scheduled-statuses";
import { startTaskScheduler } from "./lib/task-scheduler";
import { startTelegramBot } from "./lib/telegram";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// The Clerk Frontend API proxy streams raw bytes, so it must run before the
// body parsers. It is a no-op in development (Clerk hits dev FAPI directly).
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

// Start WhatsApp connections and the status scheduler on boot. Ensure the
// legacy tenant row exists first so any inserts triggered by these services
// (or by HTTP writes once the server is listening) have a valid tenant to
// attach to. The legacy auth dir is migrated under tenant-1/ before any connect,
// then every previously-active tenant is reconnected (staggered). Awaited by the
// entrypoint before app.listen() so there is no startup race.
export async function bootstrap(): Promise<void> {
  await ensureLegacyTenant();
  migrateLegacyAuthDir();
  await bootRestoreTenants();
  startStatusScheduler();
  startTaskScheduler();
  startTelegramBot();
}

export default app;
