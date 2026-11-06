import type { ScriptLog } from "../../../server/src/script-types";

export function safeLogValue(value: unknown): unknown {
  const seen = new Set<object>();
  let budget = 150;
  const visit = (item: unknown, depth: number): unknown => {
    if (--budget < 0) return "[Truncated]";
    if (typeof item === "string") return item.slice(0, 2000);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item !== "object") return String(item).slice(0, 2000);
    if (seen.has(item)) return "[Circular]";
    if (depth > 4) return "[Max depth]";
    seen.add(item);
    try {
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).slice(0, 30)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        output[key.slice(0, 200)] = descriptor && "value" in descriptor
          ? visit(descriptor.value, depth + 1) : "[Accessor]";
      }
      return output;
    } catch {
      return "[Unserializable]";
    }
  };
  try { return visit(value, 0); } catch { return "[Unserializable]"; }
}

export function createScriptConsole(emit: (entry: ScriptLog) => void) {
  let count = 0;
  let size = 0;
  let closed = false;
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const captured = {} as Record<typeof methods[number], (...args: unknown[]) => void>;
  for (const level of methods) {
    captured[level] = (...args) => {
      if (closed) return;
      const entry: ScriptLog = {
        timestamp: new Date().toISOString(), level,
        args: args.slice(0, 10).map(safeLogValue),
      };
      const length = JSON.stringify(entry).length;
      if (count >= 200 || size + length > 64_000) {
        closed = true;
        emit({ timestamp: entry.timestamp, level: "warn", args: ["Log limit reached; further output omitted."] });
        return;
      }
      count++;
      size += length;
      emit(entry);
    };
  }
  return { console: Object.freeze(captured), close: () => { closed = true; } };
}
