import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ScriptLog, ScriptOutcome, ScriptReply } from "./script-types.js";

function limit(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(Math.floor(value), max) : fallback;
}

export class ScriptLogs {
  readonly directory = path.resolve(process.env.FIGMA_SCRIPT_LOG_DIR || path.join(homedir(), ".figma-mcp-free", "logs"));
  private maxBytes = limit("FIGMA_SCRIPT_LOG_MAX_BYTES", 1_048_576, 4096, 16_777_216);
  private maxFiles = limit("FIGMA_SCRIPT_LOG_MAX_FILES", 100, 1, 10_000);
  private maxAge = limit("FIGMA_SCRIPT_LOG_MAX_DAYS", 7, 1, 3650) * 86_400_000;

  async save(outcome: ScriptOutcome, description: string, logs: ScriptLog[], replace = false): Promise<ScriptReply> {
    const logsPath = path.join(this.directory, `script-${outcome.requestId}.jsonl`);
    const reply: ScriptReply = { ...outcome, logsPath, logsTail: logs.slice(-5).map(entry => ({
      ...entry, args: [JSON.stringify(entry.args).slice(0, 1200)],
    })) };
    try {
      await mkdir(this.directory, { recursive: true });
      const records: unknown[] = [{ event: "request", requestId: outcome.requestId, description },
        ...logs.map(log => ({ event: "console", ...log })), { event: "outcome", ...outcome }];
      const lines: string[] = [];
      let bytes = 0;
      for (const record of records) {
        let line = JSON.stringify(record) + "\n";
        if (Buffer.byteLength(line) > this.maxBytes / 2) {
          line = JSON.stringify({ event: "truncated-record", preview: line.slice(0, Math.floor(this.maxBytes / 12)) }) + "\n";
        }
        if (bytes + Buffer.byteLength(line) > this.maxBytes - 128) {
          lines.push('{"event":"truncated","message":"Log file size limit reached"}\n');
          break;
        }
        bytes += Buffer.byteLength(line);
        lines.push(line);
      }
      await writeFile(logsPath, lines.join(""), { flag: replace ? "w" : "wx", mode: 0o600 });
      await this.prune(logsPath);
    } catch (error) {
      reply.logsError = `Could not persist or prune logs: ${error instanceof Error ? error.message : String(error)}`;
    }
    return reply;
  }

  private async prune(current: string): Promise<void> {
    const names = (await readdir(this.directory)).filter(name => /^script-[a-f0-9-]{36}\.jsonl$/.test(name));
    const files = await Promise.all(names.map(async name => {
      const file = path.join(this.directory, name);
      return { file, modified: (await stat(file)).mtimeMs };
    }));
    files.sort((a, b) => b.modified - a.modified);
    for (const [index, item] of files.entries()) {
      if (item.file !== current && (index >= this.maxFiles || Date.now() - item.modified > this.maxAge)) {
        await unlink(item.file);
      }
    }
  }
}
