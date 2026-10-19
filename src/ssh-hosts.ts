/**
 * SSH hosts (the panel's SSH Hosts page, admins): servers agents run shell commands on through the gateway's MCP tools (ssh_*), with
 * a login Dalang keeps. The agent names a host and a command; it never gets the address, user, password, key or
 * passphrase, and those secrets are taken out of whatever the command prints. Admins add the hosts; each has an access
 * level like a project's and an agent mode: off, every command after an admin's approval, or run at once (but for
 * commands that read as dangerous, which still wait for an admin).
 *
 * A host is known by its key, as for an SSH tunnel (trust on first use when the host is tested, refused when it changes).
 */
import { sshConnect, type SshLogin } from './ssh-tunnel.js';
import type { Store } from './store.js';
import type { ProjectAccess } from './util.js';

export const SSH_AGENT_MODES = ['off', 'approve', 'run'] as const;
export type SshAgentMode = (typeof SSH_AGENT_MODES)[number];

export interface SshHost extends SshLogin {
  /** Its name for agents and in URLs: lowercase letters, digits, - and _. */
  id: string;
  label: string;
  /** What agents are told it is ("staging web server, the app lives in /opt/app"). */
  note: string;
  /** For `sudo: true`; empty: the login password (password login), else sudo must not ask for one. */
  sudoPassword: string;
  access: ProjectAccess;
  agent: SshAgentMode;
  /** On a 'run' host: more commands to hold for approval, as case-insensitive regular expressions (besides DANGER). */
  holdPatterns?: string[];
}

/** What one command gave: its exit code (null when it was killed or timed out), and what it printed. */
export interface SshRun {
  exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; ms: number;
}

const KEY = 'ssh_hosts';
const LOG_MAX = 200;
export const EDIT_HOST = 'open the host on the SSH Hosts page, Test connection, then Save';

export function loadHosts(store: Store): SshHost[] {
  try {
    const list = JSON.parse(store.getKv(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export const saveHosts = (store: Store, list: SshHost[]) => store.setKv(KEY, JSON.stringify(list));

// ---------- commands a 'run' host still holds for approval ----------

const ARGS = String.raw`(?:\S+\s+)*?`; // the words between a program and the one that matters
/**
 * Commands that destroy, lock out or take a machine down, by how they read. A 'run' host holds a command that matches
 * one for an admin. Best effort: shell can hide anything (a variable, a script written in one call and run in the
 * next), so this catches the plain forms; a user with only the rights it needs, or 'approve', is the real limit.
 */
const DANGER: [RegExp, string][] = [
  [new RegExp(String.raw`\brm\s+${ARGS}(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b`), 'rm -r / -f: deletes files'],
  [/\bfind\b[^;&|]*(-delete\b|-exec(dir)?\s+(\S*\/)?(rm|shred|mv|truncate)\b)|\bxargs\s+(?:\S+\s+)*?(\S*\/)?(rm|shred|kill)\b/, 'deletes or kills what it finds'],
  [/\b(mkfs(\.\w+)?|wipefs|shred|fdisk|sfdisk|gdisk|parted|mkswap|blkdiscard)\b/, 'formats or wipes a disk'],
  [/\bdd\b[^;&|]*\bof=|>\s*\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|disk|dm-|mapper)/, 'writes straight to a disk'],
  [/\btruncate\b|(^|[^>&0-9])>\s*\/(etc|boot|usr|bin|sbin|lib\w*|var\/lib)\//, 'empties or overwrites files'],
  [/\b(shutdown|reboot|poweroff|halt)\b|\b(tel)?init\s+[06]\b/, 'shuts down or restarts the machine'],
  [new RegExp(String.raw`\bsystemctl\s+${ARGS}(stop|restart|disable|mask|kill|isolate|poweroff|reboot|halt|rescue|emergency)\b|\bservice\s+\S+\s+(stop|restart)\b`), 'stops or restarts a service'],
  [/\b(kill|pkill|killall)\b/, 'kills processes'],
  [/\b(passwd|chpasswd|useradd|userdel|usermod|groupdel|groupmod|adduser|deluser|visudo|vipw)\b/, 'changes users or passwords'],
  [/(sudoers|authorized_keys|\/etc\/(shadow|passwd|group|gshadow|ssh\/sshd_config|pam\.d))/, 'touches who may log in or use sudo'],
  [new RegExp(String.raw`\b(chmod|chown|chgrp)\s+${ARGS}(-[a-zA-Z]*R|--recursive)\b|\b(chmod|chown|chgrp)\s+${ARGS}\/(\s|$)|\bchattr\b`), 'changes owners or rights recursively'],
  [/\b(ip6?tables|ebtables)\b[^;&|]*(\s-[AIDFXPRZNE]\b|--(append|insert|delete|flush|policy|replace))|\bufw\s+(enable|disable|reset|deny|allow|reject|limit|delete|insert)\b|\bnft\s+(add|delete|flush|replace|destroy|-f)\b|\bfirewall-cmd\b[^;&|]*--(add|remove|set|reload|panic|complete-reload)/, 'changes the firewall'],
  [new RegExp(String.raw`\bip\s+(link|addr|address|route|r|a|l)\s+${ARGS}(down|del|delete|flush)\b|\bifdown\b|\bnmcli\b[^;&|]*\b(down|delete|off)\b`), 'takes the network down'],
  [/\b(apt|apt-get|aptitude|yum|dnf|zypper|apk|snap|brew|pip3?)\b[^;&|]*\b(remove|purge|autoremove|erase|uninstall|del)\b|\bpacman\s+-R|\bdpkg\s+(-r|-P|--remove|--purge)\b|\brpm\s+(-e|--erase)\b/, 'removes packages'],
  [new RegExp(String.raw`\b(docker|podman|nerdctl)\s+${ARGS}(rm|rmi|kill|prune|stop|down)\b|\bdocker-compose\s+${ARGS}(down|rm|kill|stop)\b|\bkubectl\s+${ARGS}(delete|drain|cordon|scale)\b|\bhelm\s+(uninstall|delete|rollback)\b`), 'removes or stops containers'],
  [/\b(mount|umount|swapoff|losetup)\b|\bsetenforce\b|\bsysctl\s+(-w|--write)\b/, 'mounts disks or changes kernel settings'],
  [/\|\s*(sudo\s+)?(\S*\/)?(sh|bash|zsh|dash|ksh|fish|python[0-9.]*|perl|ruby|node|php)\b|\beval\b|\bbase64\s+(-d|--decode)\b|\bxxd\s+-r\b/, 'runs hidden or downloaded code'],
  [/(^|[;&|(]\s*|\b(sh|bash|zsh|source|\.)\s+)\S*\.sh\b/, 'runs a script file (its content is not checked)'],
  [/\bcrontab\s+(-\w*r|-\w*e)\b/, 'removes or edits the crontab'],
  [/\b(drop\s+(table|database|schema|user)|truncate\s+table|flushall|flushdb|dropdatabase)\b/i, 'drops databases or tables'],
  [new RegExp(String.raw`\bgit\s+(reset\s+${ARGS}--hard|clean\s+${ARGS}-[a-zA-Z]*f|push\s+${ARGS}(--force\S*|-f)\b|branch\s+-D)`), 'throws away git work'],
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, 'a fork bomb'],
];

/**
 * Why `command` is held on a 'run' host: the danger it reads as (see DANGER), and each of the host's own patterns it
 * matches (case-insensitive regular expressions). Empty: it runs at once.
 */
export function findDangerous(command: string, extra: string[] = []): string[] {
  const out = DANGER.filter(([re]) => re.test(command)).map(([, why]) => why);
  for (const p of extra) {
    try { if (new RegExp(p, 'i').test(command)) out.push(`matches this host's pattern ${p}`); } catch { /* checked when saved */ }
  }
  return [...new Set(out)];
}

/** A word for sh, quoted. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The password sudo is given on this host, or '' (then sudo runs with -n and fails rather than asking). */
const sudoSecret = (h: SshHost) => h.sudoPassword || (h.auth === 'password' ? h.password : '');

/**
 * `text` with every secret of `h` in it replaced: the passwords, the passphrase, and each line of the private key's
 * body (a command could print a key file that is the same key).
 */
export function redact(text: string, h: Pick<SshHost, 'password' | 'passphrase' | 'sudoPassword' | 'privateKey'>): string {
  const secrets = [h.password, h.passphrase, h.sudoPassword, ...h.privateKey.split(/\r?\n/).filter((l) => !l.startsWith('-----')).map((l) => l.trim())]
    .filter((s) => s && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of new Set(secrets)) out = out.split(s).join('[secret]');
  return out;
}

/** Keeps the first and the last `half` bytes of a stream, and whether anything in between was dropped. */
class Capture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail = Buffer.alloc(0);
  dropped = false;
  constructor(private half: number) {}
  add(d: Buffer): void {
    if (this.headLen < this.half) {
      const take = d.subarray(0, this.half - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      d = d.subarray(take.length);
    }
    if (!d.length) return;
    const t = Buffer.concat([this.tail, d]);
    if (t.length > this.half) this.dropped = true;
    this.tail = t.subarray(Math.max(0, t.length - this.half));
  }
  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = this.tail.toString('utf8');
    return this.dropped ? `${head}\n… (output cut) …\n${tail}` : head + tail;
  }
}

export interface RunOpts {
  /** Run it through sudo (given the host's sudo password, when sudo asks for one). */
  sudo?: boolean;
  timeoutMs: number;
  /** At most this many bytes of stdout and of stderr each (the start and the end are kept). */
  maxOutput?: number;
}

/**
 * Runs `command` on `h` in a fresh SSH session, without a terminal and with nothing on its standard input, and closes
 * the session afterwards. What it prints comes back with the host's secrets taken out. A command still running after
 * `timeoutMs` is cut off (the session closes; `timedOut`).
 */
export async function runCommand(h: SshHost, command: string, o: RunOpts): Promise<SshRun> {
  const t0 = Date.now();
  // A failed login names the address ("connect ECONNREFUSED 10.0.0.12:22"): agents get the host's name instead.
  const hide = (e: unknown) => new Error(redact((e as Error).message, h).split(h.host).join(`host "${h.id}"`));
  const { client } = await sshConnect(h, { edit: EDIT_HOST }).catch((e) => { throw hide(e); });
  // The password goes to sudo only when sudo will read it: one it does not ask for (NOPASSWD, a cached login) would be
  // left on the command's standard input. When it is given, -k makes sudo read it even if a login was cached meanwhile,
  // and the command's own input is /dev/null, so a line sudo left unread still never reaches it.
  const secret = o.sudo && sudoSecret(h) && !(await sudoWithoutPassword(client)) ? sudoSecret(h) : '';
  const line = !o.sudo ? command
    : secret ? `sudo -S -k -p '' -- sh -c ${shQuote(`exec </dev/null\n${command}`)}` : `sudo -n -- sh -c ${shQuote(command)}`;
  const half = Math.floor((o.maxOutput ?? 100_000) / 2);
  const out = new Capture(half);
  const err = new Capture(half);
  return new Promise<SshRun>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      resolve({
        exitCode, signal, stdout: redact(out.text(), h), stderr: redact(err.text(), h), truncated: out.dropped || err.dropped, timedOut,
        ms: Date.now() - t0,
      });
    };
    const timer = setTimeout(() => { timedOut = true; finish(null, null); }, o.timeoutMs);
    client.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); client.end(); reject(hide(e)); } });
    client.on('close', () => finish(null, null));
    client.exec(line, (e, stream) => {
      if (e) { settled = true; clearTimeout(timer); client.end(); reject(new Error(`SSH ${h.id}: ${e.message}`)); return; }
      stream.on('data', (d: Buffer) => out.add(d));
      stream.stderr.on('data', (d: Buffer) => err.add(d));
      let exit: [number | null, string | null] = [null, null];
      stream.on('exit', (code: number | null, signal?: string) => { exit = [typeof code === 'number' ? code : null, signal ?? null]; });
      stream.on('close', () => finish(...exit));
      if (secret) stream.write(`${secret}\n`);
      stream.end();
    });
  });
}

/** Whether sudo runs a shell for the login user without asking for a password (NOPASSWD, or a login it cached). */
function sudoWithoutPassword(client: Awaited<ReturnType<typeof sshConnect>>['client'], timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.exec('sudo -n -- sh -c :', (e, stream) => {
      if (e) { clearTimeout(timer); resolve(false); return; }
      let code: number | null = null;
      stream.on('exit', (c: number | null) => { code = c; });
      stream.on('close', () => { clearTimeout(timer); resolve(code === 0); });
      stream.resume();
      stream.stderr.resume();
      stream.end();
    });
  });
}

/** Logs in (trusting a host seen for the first time) and asks what it is: for Test connection. */
export async function testHost(h: SshHost): Promise<{ hostKey: string; info: string }> {
  const { client, hostKey } = await sshConnect(h, { trustNew: true });
  client.end();
  const r = await runCommand({ ...h, hostKey }, 'uname -srm; id -un', { timeoutMs: 15_000, maxOutput: 4000 }).catch(() => null);
  return { hostKey, info: r?.stdout.trim().replace(/\n/g, ' · ') ?? '' };
}

/** For a chat message and the approval card: the exit and what it printed, cut to `max` characters. */
export function describeRun(r: SshRun, max = 8000): string {
  const status = r.timedOut ? 'timed out (cut off)' : r.exitCode === null ? `ended by ${r.signal ?? 'the connection closing'}` : `exit code ${r.exitCode}`;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);
  const parts = [status];
  if (r.stdout.trim()) parts.push(`stdout:\n${cut(r.stdout.trimEnd(), max)}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${cut(r.stderr.trimEnd(), Math.floor(max / 2))}`);
  return parts.join('\n');
}

// ---------- log ----------

/** One agent command, for the host's log (admins read it on the SSH Hosts page). */
export interface SshLogEntry {
  at: number; who: string; conv: string | null; command: string; sudo?: boolean; ok: boolean; exitCode?: number | null; ms: number; error?: string;
}
const logKey = (id: string) => `ssh_log:${id}`;
export function readSshLog(store: Store, id: string): SshLogEntry[] {
  try { return JSON.parse(store.getKv(logKey(id)) ?? '[]'); } catch { return []; }
}
export function logSsh(store: Store, id: string, entry: SshLogEntry): void {
  store.setKv(logKey(id), JSON.stringify([entry, ...readSshLog(store, id)].slice(0, LOG_MAX)));
}
export const clearSshLog = (store: Store, id: string) => store.setKv(logKey(id), '[]');

// ---------- approvals ----------

/** A command an agent wants to run on an 'approve' host, waiting for an admin (or decided). */
export interface SshApproval {
  id: number; host: string; command: string; sudo: boolean; timeoutMs: number; who: string; conv: string | null; at: number;
  status: 'pending' | 'approved' | 'rejected' | 'failed'; decidedBy?: string; decidedAt?: number;
  /** What running it gave (or why it failed). */
  outcome?: string;
  /** On a 'run' host: why it was held (see findDangerous). */
  dangerous?: string[];
  /** The server it was asked for (targetOf): an approval does not run on a host since pointed elsewhere. */
  target?: string;
}

/** Which server a host reaches, as user@host:port. */
export const targetOf = (h: Pick<SshHost, 'user' | 'host' | 'port'>) => `${h.user}@${h.host}:${h.port}`;
const APPROVALS = 'ssh_approvals';
export function readSshApprovals(store: Store): SshApproval[] {
  try { return JSON.parse(store.getKv(APPROVALS) ?? '[]'); } catch { return []; }
}
/** Keeps every pending one and the last 200 decided. */
function saveSshApprovals(store: Store, list: SshApproval[]): void {
  const decided = list.filter((a) => a.status !== 'pending').slice(-LOG_MAX);
  store.setKv(APPROVALS, JSON.stringify(list.filter((a) => a.status === 'pending' || decided.includes(a))));
}
export function createSshApproval(store: Store, a: Omit<SshApproval, 'id' | 'at' | 'status'>): SshApproval {
  const list = readSshApprovals(store);
  const next: SshApproval = { ...a, id: Math.max(0, ...list.map((x) => x.id)) + 1, at: Date.now(), status: 'pending' };
  saveSshApprovals(store, [...list, next]);
  return next;
}
/** Changes one approval in the list as stored now: others may have come or been decided meanwhile. */
export function updateSshApproval(store: Store, id: number, patch: Partial<SshApproval>): void {
  const list = readSshApprovals(store);
  const a = list.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  saveSshApprovals(store, list);
}
