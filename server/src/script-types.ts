export type ScriptStatus = "success" | "error" | "rejected" | "unavailable" | "timeout" | "unknown";

export interface ScriptError {
  message: string;
  stack?: string;
}

export interface ScriptLog {
  timestamp: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  args: unknown[];
}

export interface ScriptOutcome {
  requestId: string;
  status: ScriptStatus;
  result?: unknown;
  error?: ScriptError;
}

export interface ScriptReply extends ScriptOutcome {
  logsPath: string;
  logsTail: ScriptLog[];
  logsError?: string;
}

export interface ScriptRequest {
  type: "request_script_execution";
  requestId: string;
  params: { description: string; code: string; executionTimeoutMs: number };
}

export interface ScriptCard {
  requestId: string;
  description: string;
  code: string;
  token: string;
  sessionId: string;
  phase: "approval" | "running" | "finished";
  outcome?: ScriptOutcome;
}
