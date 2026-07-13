import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_PATH = new URL("../data/events.log", import.meta.url).pathname;
const UNILAB_LOG_PATH = new URL("../data/unilab-calls.log", import.meta.url).pathname;

export function logEvent(event: Record<string, unknown>) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, line + "\n");
  console.log(line);
}

export interface UniLabCallLog {
  vault: string;
  endpoint: string;
  request: Record<string, unknown>;
  httpStatus: number;
  response: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Full audit trail of every uni-lab.xyz query — request body, HTTP status,
 * raw response (or error), and latency — one line per call, appended
 * regardless of success or failure. This is the paid API the agent's design
 * revolves around (PLAN.md), so keeping every request/response pair is what
 * makes a rebalance decision reconstructable after the fact.
 */
export function logUniLabCall(call: UniLabCallLog) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...call });
  mkdirSync(dirname(UNILAB_LOG_PATH), { recursive: true });
  appendFileSync(UNILAB_LOG_PATH, line + "\n");
  console.log(`[uni-lab] ${call.endpoint} vault=${call.vault} status=${call.httpStatus} ok=${call.ok} (${call.durationMs}ms)`);
}
