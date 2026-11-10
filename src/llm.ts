import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import { config } from "./config.ts";

type Params = Omit<GenerateContentParameters, "model">;

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

// Free-tier keys hit per-model rate limits (the daily cap is 20 requests per
// model) and "high demand" 503s, and Google retires model names. A model that
// answers 404, 429 or 5xx sits out and the next one in the list takes over.
// When Google says how long to wait (a spent daily quota), we wait that long.
const COOLDOWN_MS = 2 * 60 * 1000;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const cooling = new Map<string, { until: number; reason: string }>();

export class ModelsUnavailable extends Error {}

function isTransient(error: unknown): boolean {
  return error instanceof ApiError && [404, 429, 500, 502, 503, 504].includes(error.status);
}

function rejectsThinkingLevel(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && /thinking level/i.test(error.message);
}

export function retryDelayMs(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const match = error.message.match(/retryDelay\\?"\s*:\s*\\?"(\d+(?:\.\d+)?)s/);
  return match ? Math.min(Number(match[1]) * 1000, MAX_COOLDOWN_MS) : null;
}

export function coolDown(model: string, ms = COOLDOWN_MS, reason = "busy"): void {
  cooling.set(model, { until: Date.now() + ms, reason });
}

export function availableModels(models: string[]): string[] {
  const now = Date.now();
  const ready = models.filter((m) => (cooling.get(m)?.until ?? 0) <= now);
  return ready.length > 0 ? ready : models;
}

function describeCooling(models: string[]): string {
  const now = Date.now();
  return models
    .map((m) => {
      const entry = cooling.get(m);
      if (!entry || entry.until <= now) return `${m}: failed`;
      return `${m}: ${entry.reason}, back in ${Math.ceil((entry.until - now) / 60_000)} min`;
    })
    .join("; ");
}

async function withFallback<T>(
  models: string[],
  params: Params,
  call: (request: GenerateContentParameters) => Promise<T>,
): Promise<{ model: string; result: T }> {
  for (const model of availableModels(models)) {
    try {
      try {
        return { model, result: await call({ ...params, model }) };
      } catch (error) {
        // Not every model accepts every thinking level (MINIMAL is Flash-only).
        if (!rejectsThinkingLevel(error)) throw error;
        const lowered = { ...params.config, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } };
        return { model, result: await call({ ...params, config: lowered, model }) };
      }
    } catch (error) {
      if (!isTransient(error)) throw error;
      const wait = retryDelayMs(error);
      const outOfQuota = wait !== null && wait > COOLDOWN_MS;
      coolDown(model, Math.max(wait ?? 0, COOLDOWN_MS), outOfQuota ? "daily quota used up" : `${(error as ApiError).status}`);
    }
  }
  throw new ModelsUnavailable(`No Gemini model can answer right now (${describeCooling(models)}).`);
}

export function generate(models: string[], params: Params) {
  return withFallback(models, params, (request) => gemini().models.generateContent(request));
}

export function generateStream(
  models: string[],
  params: Params,
): Promise<{ model: string; result: AsyncGenerator<GenerateContentResponse> }> {
  return withFallback(models, params, (request) => gemini().models.generateContentStream(request));
}
