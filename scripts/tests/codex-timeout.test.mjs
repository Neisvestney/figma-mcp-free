import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setCodexTimeout } from "../set-codex-timeout.mjs";

test("sets timeout only on the fork server and preserves nested and unrelated tables", () => {
  const before = '[mcp_servers.other]\ntool_timeout_sec = 90\n\n';
  const server = '[mcp_servers.figma-mcp-free]\ncommand = "node"\nargs = [\n  "path with spaces/index.js",\n]\n\n';
  const after = '[mcp_servers.figma-mcp-free.env]\nTOKEN = "preserve"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
  const result = setCodexTimeout(before + server + after);
  assert.equal(result, before + server.replace('\ncommand', '\ntool_timeout_sec = 600\ncommand') + after);
  assert.equal(setCodexTimeout(result), result);
});

test("updates an existing timeout and supports quoted server keys", () => {
  for (const key of ['"figma-mcp-free"', "'figma-mcp-free'"]) {
    const config = `[mcp_servers.${key}] # local server\ncommand = "node"\ntool_timeout_sec = 60 # default\n`;
    assert.equal(setCodexTimeout(config), config.replace('60 # default', '600'));
  }
});

test("preserves Windows newlines", () => {
  const config = '[mcp_servers.figma-mcp-free]\r\ncommand = "node"\r\n';
  assert.equal(setCodexTimeout(config), '[mcp_servers.figma-mcp-free]\r\ntool_timeout_sec = 600\r\ncommand = "node"\r\n');
});

test("handles a table at end of file without a trailing newline", () => {
  const config = '[mcp_servers.figma-mcp-free]';
  const result = `${config}\ntool_timeout_sec = 600\n`;
  assert.equal(setCodexTimeout(config), result);
  assert.equal(setCodexTimeout(result), result);
});

test("refuses missing or duplicate server tables", () => {
  assert.throws(() => setCodexTimeout('[mcp_servers.other]\ncommand = "node"\n'));
  assert.throws(() => setCodexTimeout('[mcp_servers.figma-mcp-free]\n[mcp_servers.figma-mcp-free]\n'));
});

test("ignores examples inside multiline strings and quote delimiters in comments", () => {
  for (const delimiter of ['"""', "'''", '""""', "''''"]) {
    const opening = delimiter.slice(0, 3);
    const example = '[mcp_servers.figma-mcp-free]\ntool_timeout_sec = 42\n';
    const before = `# literal ${opening}\ndeveloper_instructions = ${opening}\n${example}${delimiter}\n`;
    const server = '[mcp_servers.figma-mcp-free]\ncommand = "node"\n';
    const nested = `notes = ${opening}\n[other]\ntool_timeout_sec = 15\n${delimiter}\n`;
    const result = before + server.replace('\ncommand', '\ntool_timeout_sec = 600\ncommand') + nested;
    assert.equal(setCodexTimeout(before + server + nested), result);
    assert.equal(setCodexTimeout(result), result);
  }
});

test("CLI updates the requested file and leaves it intact when the server table is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "figma-codex-timeout-"));
  const configPath = join(dir, "config with spaces.toml");
  const scriptPath = fileURLToPath(new URL("../set-codex-timeout.mjs", import.meta.url));
  try {
    const config = '[mcp_servers.figma-mcp-free]\ncommand = "node"\n';
    writeFileSync(configPath, config);
    const updated = spawnSync(process.execPath, [scriptPath, configPath], { encoding: "utf8" });
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(readFileSync(configPath, "utf8"), setCodexTimeout(config));

    const unrelated = '[mcp_servers.other]\ncommand = "node"\n';
    writeFileSync(configPath, unrelated);
    const rejected = spawnSync(process.execPath, [scriptPath, configPath], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.equal(readFileSync(configPath, "utf8"), unrelated);
  } finally {
    unlinkSync(configPath);
    rmdirSync(dir);
  }
});
