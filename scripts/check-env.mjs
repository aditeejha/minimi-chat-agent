import { existsSync, readFileSync } from "node:fs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `\nThis project needs Node 22.18 or newer (it runs TypeScript and SQLite natively). You have ${process.versions.node}.\n`,
  );
  process.exit(1);
}

const fromFile = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const missing = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"].filter(
  (name) => !process.env[name] && !new RegExp(`^${name}=\\S+`, "m").test(fromFile),
);
if (missing.length > 0) {
  console.warn(
    `\nMissing ${missing.join(" and ")}. Copy .env.example to .env and fill them in; the UI will show an error until you do.\n`,
  );
}
