import { fakeClickUp as fakeApi } from './fake-clickup-api.js';

/** Separate service hosts and credentials for the public API and OAuth-only MCP calls. */
export function fakeClickUp(calls: string[] = []): typeof fetch {
  const rest = fakeApi(calls);
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  function tool(name: string, a: Record<string, any>) {
    switch (name) {
      case 'clickup_get_user': return { user: { id: 11, username: 'luz' } };
      case 'clickup_search': return { results: [{ id: 'doc1', name: 'Runbook' }] };
      case 'clickup_send_chat_message': return { success: true, message_id: 'new1' };
      case 'clickup_request_attachment_upload': return {
        upload_url: 'https://mcp.clickup.com/upload', upload_ticket: a.channel_id ?? `reply:${a.parent_message_id}`,
      };
      default: throw new Error(`Unexpected call to ClickUp MCP: ${name}`);
    }
  }

  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.clickup.com') return rest(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.hostname !== 'mcp.clickup.com') return json({ error: 'not ClickUp MCP' }, 404);
    if (url.pathname === '/oauth/register') {
      calls.push(`REGISTER ${JSON.parse(String(init?.body)).redirect_uris}`);
      return json({ client_id: 'client1' }, 201);
    }
    if (url.pathname === '/oauth/token') {
      const q = new URLSearchParams(String(init?.body));
      return q.get('code') === 'code1' && q.get('client_id') === 'client1' && q.get('code_verifier')
        ? json({ access_token: 'mcp_test', token_type: 'Bearer', expires_in: 315360000 }) : json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/upload') {
      const f = (init?.body as FormData).get('attachment') as File;
      calls.push(`UPLOAD ${headers['x-upload-ticket']} ${f.name} ${f.size}`);
      const failing = /^bad-(\d{3})\./.exec(f.name);
      if (failing) return json({ error: 'upload failed' }, Number(failing[1]));
      // ClickUp says where a file on a task is, not one waiting for its message
      return json({ id: `f-${f.name}`, title: f.name, ...(String(headers['x-upload-ticket']).startsWith('task:') && { url: `https://files.example/${f.name}` }) });
    }
    if (url.pathname !== '/mcp') return json({ error: 'nope' }, 404);
    if (headers.authorization !== 'Bearer mcp_test') return json({ error: 'invalid_token' }, 401);
    const m = JSON.parse(String(init?.body));
    const { name, arguments: args } = m.params;
    calls.push(`${name} ${JSON.stringify(args)}`);
    const result = (o: unknown, isError = false) => {
      const body = { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }], isError } };
      // answered as an event stream, as the real server does
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    return result(tool(name, args));
  }) as typeof fetch;
}

/** The calls that change something in ClickUp, and the uploads. */
export const changes = (calls: string[]) => calls.filter((c) => /^(POST |PUT |DELETE |UPLOAD |clickup_(send|create|update|move|add|remove)_)/.test(c));
