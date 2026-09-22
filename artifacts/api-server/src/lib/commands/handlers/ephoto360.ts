import type { Command } from "../types";
import { tryAcquire } from "../limiter";
import { fetchImageBuffer } from "../http-utils";
import { logger } from "../../logger";

const EPHOTO_BASE = "https://en.ephoto360.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const STEP_TIMEOUT_MS = 15000;
const SUBMIT_TIMEOUT_MS = 20000;
const POLL_DEADLINE_MS = 30000;
const POLL_INTERVAL_MS = 1500;
const MAX_TEXT_LEN = 30;

interface Effect {
  path: string;
  label: string;
}

const EFFECTS: Record<string, Effect> = {
  neonlight: {
    path: "/create-colorful-neon-light-text-effects-online-797.html",
    label: "Neon Light",
  },
  wings: { path: "/neon-devil-wings-text-effect-online-683.html", label: "Neon Devil Wings" },
  glitchtext: { path: "/create-pixel-glitch-text-effect-online-769.html", label: "Glitch Text" },
  naruto: { path: "/naruto-shippuden-logo-style-text-effect-online-808.html", label: "Naruto" },
  blackpink: {
    path: "/create-a-blackpink-style-logo-with-members-signatures-810.html",
    label: "Blackpink",
  },
  thunder: { path: "/thunder-text-effect-online-97.html", label: "Thunder" },
  watercolor: { path: "/create-a-watercolor-text-effect-online-655.html", label: "Watercolor" },
  foggyglass: { path: "/handwritten-text-on-foggy-glass-online-680.html", label: "Foggy Glass" },
  americanflag: {
    path: "/free-online-american-flag-3d-text-effect-generator-725.html",
    label: "American Flag 3D",
  },
  galaxy: { path: "/galaxy-text-effect-new-258.html", label: "Galaxy" },
  holographic: { path: "/free-create-a-3d-hologram-text-effect-441.html", label: "Holographic 3D" },
  dragonball: { path: "/create-dragon-ball-style-text-effects-online-809.html", label: "Dragon Ball" },
  sand3d: { path: "/realistic-3d-sand-text-effect-online-580.html", label: "3D Sand" },
};

interface FormValue {
  build_server?: string;
  [key: string]: unknown;
}

interface CreateImageResult {
  success?: boolean;
  image?: string;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** jQuery `$.param`-compatible serializer: arrays become `key[]=value`. */
function jqParam(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (k: string, v: unknown): void => {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? "" : String(v))}`);
  };
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const item of val) add(`${key}[]`, item);
    } else if (val && typeof val === "object") {
      const nested = val as Record<string, unknown>;
      for (const sub of Object.keys(nested)) add(`${key}[${sub}]`, nested[sub]);
    } else {
      add(key, val);
    }
  }
  return parts.join("&");
}

function attr(html: string, name: string): string | undefined {
  return new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1];
}

/** Only allow ephoto360's own render hosts (defense-in-depth against SSRF). */
function isYotoolsHttps(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" && (u.hostname === "yotools.net" || u.hostname.endsWith(".yotools.net"))
    );
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function renderEffect(effectPath: string, text: string): Promise<string> {
  const page = EPHOTO_BASE + effectPath;

  // Step 1: GET the effect page for the session cookie and form tokens.
  const g = await timedFetch(page, { headers: { "User-Agent": UA } });
  if (!g.ok) throw new Error(`page HTTP ${g.status}`);
  const html = await g.text();
  const cookie = (g.headers.get("set-cookie")?.match(/PHPSESSID=[^;]+/) ?? [""])[0];
  const token = attr(html, "token");
  const buildServer = attr(html, "build_server");
  const buildServerId = attr(html, "build_server_id");
  if (!token || !buildServer || !buildServerId) throw new Error("missing form tokens");
  if (!isYotoolsHttps(buildServer)) throw new Error("unexpected build server");

  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: page,
    Origin: EPHOTO_BASE,
    Cookie: cookie,
  };

  // Step 2: submit the text to obtain the form_value payload.
  const submit = new URLSearchParams();
  submit.append("text[]", text);
  submit.append("submit", "Go");
  submit.append("token", token);
  submit.append("build_server", buildServer);
  submit.append("build_server_id", buildServerId);
  const p = await timedFetch(
    page,
    { method: "POST", headers, body: submit.toString() },
    SUBMIT_TIMEOUT_MS,
  );
  if (!p.ok) throw new Error(`submit HTTP ${p.status}`);
  const resultHtml = await p.text();
  const fvi = /name="form_value_input"[^>]*value="([^"]+)"/.exec(resultHtml)?.[1];
  if (!fvi) throw new Error("no form_value");
  const formValue = JSON.parse(
    fvi.replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
  ) as FormValue;
  if (!formValue.build_server || !isYotoolsHttps(formValue.build_server)) {
    throw new Error("unexpected build server in form value");
  }

  // Step 3: poll create-image until the render is ready.
  const body = jqParam(formValue);
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const c = await timedFetch(`${EPHOTO_BASE}/effect/create-image`, {
      method: "POST",
      headers,
      body,
    });
    if (c.ok) {
      const result = (await c.json().catch(() => null)) as CreateImageResult | null;
      if (result?.success && result.image) {
        const imageUrl = result.image.startsWith("http")
          ? result.image
          : formValue.build_server + result.image;
        if (!isYotoolsHttps(imageUrl)) throw new Error("unexpected image host");
        return imageUrl;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("render timed out");
}

function effectCommand(name: string, effect: Effect): Command {
  return {
    name,
    category: "EPHOTO360",
    desc: `${effect.label} text effect`,
    handler: async (ctx) => {
      const text = ctx.text.trim();
      if (!text) {
        return ctx.reply(
          `Usage: *${ctx.prefix}${name} <text>*\nExample: *${ctx.prefix}${name} ${ctx.config.botName}*`,
        );
      }
      if (text.length > MAX_TEXT_LEN) {
        return ctx.reply(`❌ Please keep the text under ${MAX_TEXT_LEN} characters for this effect.`);
      }
      const slot = tryAcquire(`${ctx.tenantId}:${ctx.sender}`, { concurrency: true });
      if (!slot.ok) {
        await ctx.reply(slot.reason);
        return;
      }
      try {
        await ctx.react("🎨");
        const url = await renderEffect(effect.path, text);
        // Fetch the result ourselves (validating every redirect hop against
        // *.yotools.net and capping size/content-type) so Baileys never makes
        // an unchecked server-side request to a scraped URL.
        const image = await fetchImageBuffer(url, { isAllowed: isYotoolsHttps });
        await ctx.sock.sendMessage(
          ctx.from,
          { image, caption: `🎨 ${effect.label}` },
          { quoted: ctx.msg },
        );
        await ctx.react("✅");
      } catch (err) {
        logger.warn({ err, effect: name }, "ephoto360 render failed");
        await ctx.reply("❌ Couldn't generate that text effect right now. Try again in a moment.");
      } finally {
        slot.release();
      }
    },
  };
}

export const ephoto360Commands: Command[] = [];
