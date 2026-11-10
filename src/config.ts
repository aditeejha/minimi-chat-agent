export const config = {
  port: Number(process.env.PORT) || 3000,
  answerModel: process.env.ANSWER_MODEL || "claude-opus-5-5",
  plannerModel: process.env.PLANNER_MODEL || "claude-haiku-5-5",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  dbPath: process.env.DB_PATH || "data/agent.db",
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) missing.push("ANTHROPIC_API_KEY");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
