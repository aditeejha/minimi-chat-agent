function list(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  answerModels: list(process.env.ANSWER_MODELS, "gemini-3.5-flash,gemini-3.6-flash,gemini-flash-latest"),
  plannerModels: list(process.env.PLANNER_MODELS, "gemini-3.5-flash-lite,gemini-3.5-flash,gemini-flash-lite-latest"),
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  dbPath: process.env.DB_PATH || "data/agent.db",
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
