import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
  );
}

export const GEMINI_MODEL = "gemini-3.5-flash-lite";

export const gemini = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
});
