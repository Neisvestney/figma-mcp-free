import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function maskMultilineStrings(config) {
  const masked = config.split("");
  let quote = null;
  let multiline = false;
  for (let i = 0; i < config.length; i++) {
    const char = config[i];
    if (quote) {
      if (multiline && char !== "\r" && char !== "\n") masked[i] = " ";
      if (quote === '"' && char === "\\") {
        if (multiline && i + 1 < config.length && !"\r\n".includes(config[i + 1])) masked[i + 1] = " ";
        i++;
      } else if (multiline && config.startsWith(quote.repeat(3), i)) {
        const closingQuote = quote;
        do { masked[i++] = " "; } while (config[i] === closingQuote);
        i--;
        quote = null;
        multiline = false;
      } else if (!multiline && char === quote) {
        quote = null;
      }
    } else if (char === "#") {
      while (i + 1 < config.length && config[i + 1] !== "\n") i++;
    } else if (char === '"' || char === "'") {
      quote = char;
      multiline = config.startsWith(char.repeat(3), i);
      if (multiline) {
        masked.fill(" ", i, i + 3);
        i += 2;
      }
    }
  }
  return masked.join("");
}

export function setCodexTimeout(config) {
  const masked = maskMultilineStrings(config);
  const header = /^[\t ]*\[mcp_servers\.(?:figma-mcp-free|"figma-mcp-free"|'figma-mcp-free')\][\t ]*(?:#[^\r\n]*)?(?=\r?$)/gm;
  const matches = [...masked.matchAll(header)];
  if (matches.length !== 1) {
    throw new Error("Expected one figma-mcp-free table after codex mcp add");
  }

  const start = matches[0].index + matches[0][0].length;
  const rest = masked.slice(start);
  const nextTable = rest.search(/^[\t ]*\[/m);
  const end = nextTable === -1 ? config.length : start + nextTable;
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const body = config.slice(start, end);
  const timeout = /^[\t ]*tool_timeout_sec[\t ]*=[^\r\n]*/m.exec(masked.slice(start, end));
  const updated = timeout
    ? body.slice(0, timeout.index) + "tool_timeout_sec = 600" + body.slice(timeout.index + timeout[0].length)
    : `${newline}tool_timeout_sec = 600${body.startsWith("\n") || body.startsWith("\r\n") ? "" : newline}${body}`;

  return config.slice(0, start) + updated + config.slice(end);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: node scripts/set-codex-timeout.mjs <config.toml>");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(configPath, setCodexTimeout(config), "utf8");
}
