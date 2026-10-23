import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('rejects a short token', () => {
    expect(() => loadConfig({ LZVR_TOKEN: 'short', WORKSPACE_ROOT: '/w' })).toThrow(/LZVR_TOKEN/);
    expect(() => loadConfig({ LZVR_TOKEN: 'x'.repeat(31), WORKSPACE_ROOT: '/w' })).toThrow(/32/);
  });

  it('requires WORKSPACE_ROOT', () => {
    expect(() => loadConfig({ LZVR_TOKEN: 'x'.repeat(32) })).toThrow(/WORKSPACE_ROOT/);
  });

  it('applies defaults', () => {
    const c = loadConfig({ LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' });
    expect(c.trustProxy).toEqual([]);
    expect(c.port).toBe(9876);
    expect(c.host).toBe('127.0.0.1');
    expect(c.codexCommand).toEqual(['codex']);
    expect(c.limitBlockMs).toBe(3_600_000);
    expect(c.mcpCrossSend).toBe('approve');
  });

  it('reads how long a stop waits for running turns', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' };
    expect(loadConfig(base).drainMs).toBe(300_000);
    expect(loadConfig({ ...base, DRAIN_MINUTES: '0' }).drainMs).toBe(0);
    for (const bad of ['-1', 'abc', 'Infinity']) expect(() => loadConfig({ ...base, DRAIN_MINUTES: bad }), bad).toThrow(/DRAIN_MINUTES/);
  });

  it('validates how long an account stays blocked', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' };
    expect(loadConfig({ ...base, LIMIT_BLOCK_MINUTES: '30' }).limitBlockMs).toBe(1_800_000);
    for (const bad of ['0', '-5', 'abc', 'Infinity', '']) {
      expect(() => loadConfig({ ...base, LIMIT_BLOCK_MINUTES: bad }), bad).toThrow(/LIMIT_BLOCK_MINUTES/);
    }
  });

  it('configures the native context compaction window with an opt-out', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' };
    expect(loadConfig(base).contextCompactTokens).toBe(100_000);
    expect(loadConfig({ ...base, CONTEXT_COMPACT_TOKENS: '200000' }).contextCompactTokens).toBe(200_000);
    expect(loadConfig({ ...base, CONTEXT_COMPACT_TOKENS: '0' }).contextCompactTokens).toBe(0);
    for (const bad of ['-1', '99999', '1000001', '100000.5', 'abc', 'Infinity']) {
      expect(() => loadConfig({ ...base, CONTEXT_COMPACT_TOKENS: bad }), bad).toThrow(/CONTEXT_COMPACT_TOKENS/);
    }
  });

  it('reads TRUST_PROXY as the addresses of the reverse proxies to believe', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' };
    expect(loadConfig(base).trustProxy).toEqual([]);
    expect(loadConfig({ ...base, TRUST_PROXY: '0' }).trustProxy).toEqual([]);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toEqual(['127.0.0.1', '::1']);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toEqual(['127.0.0.1', '::1']);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 192.168.1.5' }).trustProxy).toEqual(['10.0.0.0/8', '192.168.1.5']);
    for (const bad of ['yes please', '10.0.0.0/8/9', '999.1.1.1', '10.0.0.1/ab']) {
      expect(() => loadConfig({ ...base, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
  });

  it('turns MCP injection into Codex on only when asked', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w', PORT: '4100' };
    expect(loadConfig(base).mcpUrl).toBeUndefined();
    expect(loadConfig({ ...base, MCP_INJECT: '1' }).mcpUrl).toBe('http://127.0.0.1:4100/mcp');
    expect(loadConfig({ ...base, MCP_INJECT: '1', MCP_URL: 'http://127.0.0.1:9/mcp' }).mcpUrl).toBe('http://127.0.0.1:9/mcp');
  });

  it('lets cross-conversation MCP sends run automatically only when asked', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' };
    expect(loadConfig({ ...base, MCP_CROSS_SEND: 'auto' }).mcpCrossSend).toBe('auto');
    expect(loadConfig({ ...base, MCP_CROSS_SEND: 'whatever' }).mcpCrossSend).toBe('approve');
  });

  it('has no notion of Codex accounts: they are all added from the panel, and CODEX_HOME is not read', () => {
    const c = loadConfig({ LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w', CODEX_HOME: '/h/ignored', CODEX_HOMES: '/h/a,/h/b' });
    expect(JSON.stringify(c)).not.toMatch(/ignored|\/h\/a/);
    expect(Object.keys(c)).not.toContain('codexHomes');
  });
});
