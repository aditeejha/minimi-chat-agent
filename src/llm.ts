import { ApiError, GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { config } from "./config.ts";

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

// Free-tier keys hit per-model rate limits, and Google retires model names.
// A model that answers 404, 429 or 5xx sits out for a while and the next one
// in the list takes over, so one busy model doesn't take the agent down.
const COOLDOWN_MS = 2 * 60 * 1000;
const coolingUntil = new Map<string, number>();

function isTransient(error: unknown): boolean {
  return error instanceof ApiError && [404, 429, 500, 502, 503, 504].includes(error.status);
}

function candidates(models: string[]): string[] {
  const now = Date.now();
  const ready = models.filter((m) => (coolingUntil.get(m) ?? 0) <= now);
  return ready.length > 0 ? ready : models;
}

async function withFallback<T>(models: string[], call: (model: string) => Promise<T>): Promise<{ model: string; result: T }> {
  const failures: string[] = [];
  for (const model of candidates(models)) {
    try {
      return { model, result: await call(model) };
    } catch (error) {
      if (!isTransient(error)) throw error;
      coolingUntil.set(model, Date.now() + COOLDOWN_MS);
      failures.push(`${model}: ${(error as ApiError).status}`);
    }
  }
  throw new Error(`Every model is unavailable right now (${failures.join(", ")}). Try again in a minute.`);
}

export function generate(models: string[], params: Omit<GenerateContentParameters, "model">) {
  return withFallback(models, (model) => gemini().models.generateContent({ ...params, model }));
}

export function generateStream(
  models: string[],
  params: Omit<GenerateContentParameters, "model">,
): Promise<{ model: string; result: AsyncGenerator<GenerateContentResponse> }> {
  return withFallback(models, (model) => gemini().models.generateContentStream({ ...params, model }));
}
