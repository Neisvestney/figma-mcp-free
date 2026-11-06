import type { ScriptCard, ScriptError, ScriptOutcome, ScriptRequest } from "../../../server/src/script-types";
import { createScriptConsole, safeLogValue } from "./script-console";

type CompiledScript = (api: PluginAPI, captured: ReturnType<typeof createScriptConsole>["console"]) => Promise<unknown>;

export function compileScript(code: string): CompiledScript {
  return new Function("figma", "console", `"use strict"; return (async () => {\n${code}\n})();`) as CompiledScript;
}

function scriptError(error: unknown): ScriptError {
  let message = "Unserializable script error";
  let stack: string | undefined;
  try {
    message = typeof error === "string" ? error : error instanceof Error && typeof error.message === "string"
      ? error.message : JSON.stringify(safeLogValue(error)) || message;
    if (error instanceof Error && typeof error.stack === "string") stack = error.stack.slice(0, 16000);
  } catch { /* Thrown values may have hostile getters or coercion. */ }
  return { message: message.slice(0, 8000), stack };
}

export class ScriptRunner {
  private sessionId: string | null = null;
  private queue: ScriptCard[] = [];
  private active: ScriptCard | null = null;
  private sequence = 0;
  private seen = new Set<string>();
  private support: Promise<string | null>;

  constructor() {
    this.support = this.probe();
  }

  async status(): Promise<void> {
    const reason = await this.support;
    figma.ui.postMessage({ type: "script-capability", supported: !reason && figma.editorType === "figma" && figma.mode === "default",
      reason, editorType: figma.editorType, mode: figma.mode });
  }

  private async probe(): Promise<string | null> {
    try {
      const result = await compileScript("await Promise.resolve(); return figma.root.id;")(figma, console);
      if (result !== figma.root.id) throw new Error("Unexpected dynamic execution probe result");
      return null;
    } catch (error) {
      return `Dynamic JavaScript is unavailable in this Figma runtime: ${scriptError(error).message}`;
    }
  }

  transport(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    for (const card of this.queue) {
      this.finish(card, { requestId: card.requestId, status: "unavailable", error: { message: "Connection lost before approval; request invalidated." } });
    }
    this.queue = [];
    this.seen.clear();
    this.sessionId = sessionId;
  }

  async request(request: ScriptRequest, sessionId: string): Promise<void> {
    const reason = await this.support;
    if (sessionId !== this.sessionId) return;
    if (this.seen.has(request.requestId)) return;
    if (this.seen.size >= 10_000) {
      figma.ui.postMessage({ type: "request_script_execution", requestId: request.requestId, sessionId,
        data: { requestId: request.requestId, status: "unavailable", error: { message: "Session request limit reached; reconnect the plugin." } } });
      return;
    }
    this.seen.add(request.requestId);
    const card: ScriptCard = {
      requestId: request.requestId, description: request.params?.description,
      code: request.params?.code, token: `${Date.now()}-${++this.sequence}`,
      sessionId, phase: "approval",
    };
    const unavailable = reason || (figma.editorType !== "figma" || figma.mode !== "default"
      ? "Script editing requires Figma Design in default mode. Dev Mode remains read-only."
      : this.queue.length >= 20 ? "Script approval queue is full." : null);
    if (unavailable || typeof card.code !== "string" || !card.code.trim() || card.code.length > 100_000 ||
        typeof card.description !== "string" || !card.description.trim() || card.description.length > 4000) {
      this.finish(card, { requestId: card.requestId, status: "unavailable", error: { message: unavailable || "Invalid script request." } });
      return;
    }
    // Timeout is transport policy, never part of model-authored code.
    this.timeouts.set(card.token, Math.max(100, Math.min(request.params.executionTimeoutMs || 30_000, 600_000)));
    this.queue.push(Object.freeze(card));
    this.present();
  }

  private timeouts = new Map<string, number>();

  private present(): void {
    if (!this.active && this.queue[0]) this.card(this.queue[0]);
  }

  private card(card: ScriptCard): void {
    figma.ui.postMessage({ type: "script-card", card });
  }

  private emit(card: ScriptCard, type: string, data?: unknown): void {
    figma.ui.postMessage({ type, requestId: card.requestId, sessionId: card.sessionId, data });
  }

  private finish(card: ScriptCard, outcome: ScriptOutcome): void {
    this.timeouts.delete(card.token);
    this.card({ ...card, phase: "finished", outcome });
    this.emit(card, "request_script_execution", outcome);
  }

  async decide(message: { requestId: string; token: string; code: string; sessionId: string; approve: boolean }): Promise<void> {
    const card = this.queue[0];
    if (typeof message.approve !== "boolean" || this.active || !card || card.requestId !== message.requestId || card.token !== message.token ||
        card.code !== message.code || card.sessionId !== message.sessionId || card.sessionId !== this.sessionId) return;
    this.queue.shift();
    if (message.approve !== true) {
      this.finish(card, { requestId: card.requestId, status: "rejected" });
      this.present();
      return;
    }
    if (figma.editorType !== "figma" || figma.mode !== "default") {
      this.finish(card, { requestId: card.requestId, status: "unavailable", error: { message: "Editing is unavailable in this mode." } });
      this.present();
      return;
    }
    this.active = card;
    this.card({ ...card, phase: "running" });
    this.emit(card, "script-started");
    const captured = createScriptConsole(entry => this.emit(card, "script-log", entry));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.finish(card, { requestId: card.requestId, status: "timeout", error: {
        message: "Execution exceeded its time limit. It may still be running; later scripts remain blocked until it settles. Inspect the document before retrying.",
      } });
    }, this.timeouts.get(card.token) || 30_000);
    let outcome: ScriptOutcome;
    try {
      figma.commitUndo();
      const result = await compileScript(card.code)(figma, captured.console);
      const json = result === undefined ? "null" : JSON.stringify(result);
      if (json === undefined || json.length > 256_000) throw new Error("Result must be JSON-serializable and at most 256000 characters.");
      outcome = { requestId: card.requestId, status: "success", result: JSON.parse(json) };
    } catch (error) {
      outcome = { requestId: card.requestId, status: "error", error: scriptError(error) };
    } finally {
      clearTimeout(timer);
      captured.close();
    }
    try { figma.commitUndo(); } catch (error) {
      const detail = scriptError(error);
      const message = `Could not commit Undo boundary: ${detail.message}`;
      outcome = { requestId: card.requestId, status: "error", error: {
        message: outcome.error ? `${outcome.error.message}\n${message}` : message,
        stack: outcome.error?.stack || detail.stack,
      } };
    }
    if (!timedOut) this.finish(card, outcome);
    else {
      this.card({ ...card, phase: "finished", outcome });
      this.emit(card, "script-settled", outcome);
    }
    this.active = null;
    this.present();
  }
}
