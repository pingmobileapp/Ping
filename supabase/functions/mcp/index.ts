// Ping's AI connector: a remote MCP server (Streamable HTTP) so people can
// use Ping from an AI app - Meta's Muse first, and Claude, ChatGPT or any
// other app that supports remote MCP connectors.
//
// Sign-in is Supabase Auth's OAuth 2.1 server. The AI app finds it through
// /.well-known/oauth-protected-resource below, the person signs in and
// approves on docs/connect.html, and the AI app then sends that person's
// access token on every request. Each request builds a supabase client with
// that token, so Row Level Security applies exactly as in the app. No service
// role anywhere.
//
// Read only: if the person picked Read only on the consent page, write tools
// are hidden and refused here - and the database refuses writes from that
// token too (ai_write_allowed() in supabase/ai_connections.sql), since the
// AI app could call the Data API directly.
//
// Deployed with verify_jwt off (deploy with --no-verify-jwt): the discovery
// document and the 401 that points to it must be reachable without a token.
// The token is checked here instead, with auth.getUser - which also fails as
// soon as the person disconnects the AI app.

import { createClient } from 'npm:@supabase/supabase-js@2.112.0';
import { TOOLS, ToolError, toolListing, type Ctx } from './tools.ts';
import { ADMIN_USER_ID } from './pingRules.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// Only for the shared photo library (see tools.ts saveToLibrary).
const libraryClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// The public address of this function. Behind the edge gateway req.url
// isn't always the public one, so it's built from SUPABASE_URL (overridable
// for local testing).
const RESOURCE_URL = Deno.env.get('MCP_RESOURCE_URL') ?? `${SUPABASE_URL}/functions/v1/mcp`;
const AUTH_SERVER = `${SUPABASE_URL}/auth/v1`;
const HELP_URL = 'https://pingmobileapp.github.io/Ping/ai.html';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'ping', title: 'Ping', version: '1.1.0', websiteUrl: HELP_URL };
const INSTRUCTIONS = [
  "Ping is a shared calendar for events with friends and family. Words to use with the person: \"New Event\", \"Invite People\", \"What to bring\", \"Discover\", \"Shared Events\".",
  'Event times: pass the person\'s IANA time_zone when you know it.',
  "Ping can't see personal items kept only in the phone's own calendar.",
  'Tools marked Sensitive write notify or affect other people - confirm with the person before each one. cancel_event and delete_group cannot be undone.',
  'set_reminder reminds only the person, with a Ping notification on their phone.',
  'When the person makes a New Event, offer to add a fitting photo (find_event_photos, then set_event_photo).',
  'People without the Ping app get invites by text from the person\'s phone; tell them to send those from the app.',
].join(' ');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

function unauthorized(detail: string) {
  return json({ error: 'invalid_token', error_description: detail }, 401, {
    'WWW-Authenticate': `Bearer realm="ping", error="invalid_token", error_description="${detail}", resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"`,
  });
}

const protectedResourceMetadata = () =>
  json({
    resource: RESOURCE_URL,
    authorization_servers: [AUTH_SERVER],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'email', 'profile'],
    resource_name: 'Ping',
    resource_documentation: HELP_URL,
  });

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
  } catch {
    return {};
  }
}

type RpcMessage = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const rpcResult = (id: RpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // OAuth 2.0 Protected Resource Metadata (RFC 9728), at the path-suffixed
  // spot under this function. The 401 below names it.
  if (path.endsWith('/.well-known/oauth-protected-resource') || path.endsWith('/.well-known/oauth-protected-resource/mcp')) {
    return protectedResourceMetadata();
  }
  // Some AI apps still look for the authorization server's metadata next to
  // the resource. Point them to Supabase Auth's own.
  if (path.endsWith('/.well-known/oauth-authorization-server') || path.endsWith('/.well-known/openid-configuration')) {
    const r = await fetch(`${SUPABASE_URL}/.well-known/oauth-authorization-server/auth/v1`);
    return new Response(await r.text(), { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Stateless server: no server-to-client stream, no sessions to end.
  if (req.method === 'GET' || req.method === 'DELETE') {
    return new Response('Method Not Allowed', { status: 405, headers: { ...CORS, Allow: 'POST' } });
  }
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

  // ---- who is this ----
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return unauthorized('Sign in to Ping to use this connector.');

  const db = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData?.user) return unauthorized('Your Ping sign-in expired or was disconnected. Sign in again.');
  const user = userData.user;
  const claims = decodeClaims(token);
  const clientId = typeof claims.client_id === 'string' && claims.client_id ? claims.client_id : null;

  // Read only unless the person chose Full access for this AI app. A token
  // without a client_id is a normal app sign-in (only used for local
  // testing) and gets full access, same as the app.
  let readOnly = false;
  if (clientId) {
    const { data: conn } = await db
      .from('ai_connections')
      .select('read_only')
      .eq('user_id', user.id)
      .eq('client_id', clientId)
      .maybeSingle();
    readOnly = conn ? conn.read_only : true;
  }
  const isAdmin = user.id === ADMIN_USER_ID;
  const visibleTools = TOOLS.filter((t) => (!readOnly || t.cls === 'read') && (!t.adminOnly || isAdmin));

  const ctx: Ctx = {
    db,
    userId: user.id,
    userEmail: user.email ?? null,
    userMeta: (user.user_metadata ?? {}) as Ctx['userMeta'],
    push: { url: SUPABASE_URL, token, apikey: ANON_KEY },
    library: libraryClient,
  };

  // ---- JSON-RPC ----
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as RpcMessage[];

  const handle = async (msg: RpcMessage): Promise<unknown | null> => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
    const isNotification = msg.id === undefined;
    if (isNotification) return null; // notifications/initialized, cancelled, ...
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: readOnly ? `${INSTRUCTIONS} This connection is Read only: the person can change that by reconnecting.` : INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: visibleTools.map(toolListing) });
      case 'resources/list':
        return rpcResult(msg.id, { resources: [] });
      case 'prompts/list':
        return rpcResult(msg.id, { prompts: [] });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = visibleTools.find((t) => t.name === name) ?? TOOLS.find((t) => t.name === name && !t.adminOnly);
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        if (readOnly && tool.cls !== 'read') {
          return rpcResult(msg.id, {
            content: [{ type: 'text', text: 'This AI app has Read only access to Ping. To make changes, disconnect it in Ping (Settings → Connected AI) and connect again with Full access.' }],
            isError: true,
          });
        }
        try {
          const text = await tool.run(ctx, args);
          return rpcResult(msg.id, { content: [{ type: 'text', text }] });
        } catch (err) {
          if (!(err instanceof ToolError)) console.error(`mcp tool ${name} failed:`, err);
          const text = err instanceof ToolError ? err.message : 'Something went wrong in Ping. Try again in a moment.';
          return rpcResult(msg.id, { content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };

  const results = (await Promise.all(messages.map(handle))).filter((r) => r !== null);
  if (results.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(batch ? results : results[0]);
});
