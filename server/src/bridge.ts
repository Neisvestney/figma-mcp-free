import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BridgeRequest, BridgeResponse } from "./types.js";
import type { ScriptLog, ScriptOutcome } from "./script-types.js";
import { ScriptLogs } from "./script-logs.js";

interface PendingRequest {
  resolve: (resp: BridgeResponse) => void;
  reject: (err: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  conn: WebSocket;
  script: boolean;
  started: boolean;
  description: string;
  logs: ScriptLog[];
  logBytes: number;
}

export class Bridge {
  private wss = new WebSocketServer({ noServer: true });
  private conn: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private late = new Map<string, { pending: PendingRequest; saved: Promise<unknown> }>();
  private logs = new ScriptLogs();
  private executionTimeout = Math.max(100, Math.min(Number(process.env.FIGMA_SCRIPT_TIMEOUT_MS) || 30_000, 600_000));

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, ws => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    if (this.conn) {
      const previous = this.conn;
      this.disconnected(previous);
      previous.close();
    }
    this.conn = ws;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) { this.disconnected(ws); ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 10_000);
    ws.on("pong", () => { alive = true; });
    ws.on("message", raw => {
      try {
        const resp = JSON.parse(raw.toString()) as BridgeResponse;
        const late = this.late.get(resp.requestId);
        const pending = this.pending.get(resp.requestId) || late?.pending;
        if (!pending || pending.conn !== ws) return;
        if (pending.script && resp.type === "script-started") {
          if (!pending.started) {
            pending.started = true;
            pending.timeout = setTimeout(() => this.complete(resp.requestId, {
              requestId: resp.requestId, status: "timeout", error: { message: "Execution result timed out. The script may still be running. Inspect the document before retrying." },
            }), this.executionTimeout + 1000);
          }
          return;
        }
        if (pending.script && resp.type === "script-log") {
          const size = JSON.stringify(resp.data).length;
          if (pending.logs.length < 201 && size < 65_000 && pending.logBytes + size < 128_000) {
            pending.logs.push(resp.data as ScriptLog);
            pending.logBytes += size;
          }
          return;
        }
        if (pending.script) {
          if (resp.type !== "request_script_execution" && resp.type !== "script-settled") return;
          const outcome = resp.data as ScriptOutcome;
          if (!outcome || outcome.requestId !== resp.requestId ||
              !["success", "error", "rejected", "unavailable", "timeout", "unknown"].includes(outcome.status)) return;
          if (late && (resp.type === "script-settled" || outcome.status !== "timeout")) {
            this.late.delete(resp.requestId);
            void late.saved.then(() => this.logs.save(outcome, pending.description, pending.logs, true));
          } else if (!late) this.complete(resp.requestId, outcome);
        } else {
          clearTimeout(pending.timeout);
          this.pending.delete(resp.requestId);
          pending.resolve(resp);
        }
      } catch {
        console.error("Invalid response from plugin");
      }
    });
    ws.on("close", () => { clearInterval(heartbeat); this.disconnected(ws); });
    ws.on("error", () => { clearInterval(heartbeat); this.disconnected(ws); ws.terminate(); });
  }

  private disconnected(conn: WebSocket): void {
    if (this.conn === conn) this.conn = null;
    for (const [id, late] of this.late) {
      if (late.pending.conn === conn) {
        this.late.delete(id);
        void late.saved.then(() => this.logs.save({ requestId: id, status: "unknown", error: {
          message: "Connection lost after timeout; final execution state unknown. Inspect the document before retrying.",
        } }, late.pending.description, late.pending.logs, true));
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.conn !== conn) continue;
      if (pending.script) this.complete(id, { requestId: id, status: "unknown", error: {
        message: "Plugin connection lost. Execution may have started or made partial changes. Inspect the document before retrying.",
      } });
      else {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(new Error("Plugin disconnected"));
      }
    }
  }

  private complete(id: string, outcome: ScriptOutcome): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    const saved = this.logs.save(outcome, pending.description, pending.logs).then(data => {
      pending.resolve({ type: "request_script_execution", requestId: id, data });
    });
    if (outcome.status === "timeout") this.late.set(id, { pending, saved });
  }

  send(requestType: string, nodeIds?: string[]): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds);
  }

  sendWithParams(requestType: string, nodeIds?: string[], params?: Record<string, unknown>): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      const script = requestType === "request_script_execution";
      const candidateId = params?._scriptRequestId;
      const requestId = script && typeof candidateId === "string" && /^[a-f0-9-]{36}$/.test(candidateId)
        ? candidateId : randomUUID();
      if (this.pending.has(requestId)) { reject(new Error("Duplicate script request ID")); return; }
      const conn = this.conn;
      if (!conn || conn.readyState !== WebSocket.OPEN) {
        if (script) {
          void this.logs.save({ requestId, status: "unavailable", error: { message: "Plugin not connected; script was not sent." } }, String(params?.description || ""), [])
            .then(data => resolve({ type: requestType, requestId, data }));
        } else reject(new Error("Plugin not connected"));
        return;
      }
      const pending: PendingRequest = {
        resolve, reject, conn, script, started: false, logs: [], logBytes: 0,
        description: String(params?.description || ""),
      };
      if (!script) pending.timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Request timed out"));
      }, 30_000);
      this.pending.set(requestId, pending);
      const request: BridgeRequest = { type: requestType, requestId, nodeIds,
        params: script ? { ...params, executionTimeoutMs: this.executionTimeout } : params };
      conn.send(JSON.stringify(request), err => {
        if (!err) return;
        if (script) this.complete(requestId, { requestId, status: "unknown", error: { message: `Delivery failed; execution state unknown: ${err.message}` } });
        else {
          clearTimeout(pending.timeout);
          this.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  close(): void {
    const conn = this.conn;
    if (conn) { this.disconnected(conn); conn.close(); }
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
