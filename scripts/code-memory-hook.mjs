// Claude Code hook for code memory (see src/code-memory.ts, claudeHooks): hands the hook event to codebase-memory-mcp's
// `hook-augment`, which adds the graph symbols matching a Grep/Glob/Bash search (or coverage gaps after a Read) as
// context. The event's folder is replaced by the chat's project folder (LZVR_CODE_ROOT): a chat in its own worktree uses
// its project's graph, a chat never reaches another project's, and CBM gets the forward slashes it needs on Windows.
// Fails open like CBM's own hook: any error or timeout prints nothing and exits 0, so it never blocks a tool call.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 4000;
const command = process.env.LZVR_CBM_COMMAND;
const root = process.env.LZVR_CODE_ROOT;
// Arguments before `hook-augment` (tests: a script for node to run).
const pre = (() => { try { return JSON.parse(process.env.LZVR_CBM_ARGS || '[]'); } catch { return []; } })();

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  if (!command || !root) return;
  let event;
  try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  event.cwd = root.replace(/\\/g, '/');
  const child = spawn(command, [...pre, 'hook-augment'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const out = [];
  const timer = setTimeout(() => { child.kill(); process.exit(0); }, TIMEOUT_MS);
  child.stdout.on('data', (c) => out.push(c));
  child.on('error', () => process.exit(0));
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) process.stdout.write(Buffer.concat(out));
    process.exit(0);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(event));
});
