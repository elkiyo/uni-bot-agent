import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_PATH = new URL("../data/events.log", import.meta.url).pathname;

export function logEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, line + "\n");
  console.log(line);
}
