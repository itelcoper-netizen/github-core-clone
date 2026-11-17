// app.ts — the HTTP server.
//
// One process, one in-memory Forge. Routes:
//   GET  /healthz                                  (no auth)
//   GET  /api/v3/ and /api/v3/meta                 (no auth)
//   *    /api/v3/**                                (Bearer token, REST v3)
//   POST /api/graphql                              (Bearer token, GraphQL v4)
//   POST /mcp                                      (Bearer token, MCP legacy era)
//   *    /{owner}/{repo}.git/info/refs             (Bearer token, git adverts)
//   POST /{owner}/{repo}.git/git-upload-pack       (Bearer token, fetch/ls-refs)
//   POST /{owner}/{repo}.git/git-receive-pack      (Bearer token, push)
// Every response carries X-GitHub-Request-Id, and every REST reply is JSON.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Forge, VIEWER_LOGIN } from './store.ts';
import { handleRest, newRequestId, errorReply, jsonReply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, type JsonRpcRequest } from './mcp.ts';
import {
  AGENT,
  servicePreamble,
  v0Advertisement,
  parseV2Request,
  lsRefsResponse,
  fetchResponse,
  parsePushBody,
  applyPush,
  pushResponse,
  readPack,
  pktLine,
  FLUSH,
  type LsRefsRequest,
  type FetchRequest,
} from './gitproto.ts';

const RECEIVE_CAPS = `agent=${AGENT} report-status report-status-v2 delete-refs side-band-64k ofs-delta symref=HEAD:refs/heads/main`;
const V0_UPLOAD_CAPS = `agent=${AGENT} symref=HEAD:refs/heads/main report-status side-band-64k ofs-delta thin-pack multi_ack multi_ack_detailed shallow`;

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const expected = expectedToken();
  if (expected === '') return match[1].length > 0;
  return match[1] === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface App {
  server: Server;
  forge: Forge;
}

export function createApp(): App {
  const forge = new Forge();

  const server = createServer((req, res) => {
    void handleRequest(forge, req, res);
  });

  return { server, forge };
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = newRequestId();
  const send = (status: number, headers: Record<string, string>, body: Buffer | null): void => {
    const allHeaders: Record<string, string> = { 'x-github-request-id': requestId, ...headers };
    if (body !== null && !allHeaders['content-length']) {
      allHeaders['content-length'] = String(body.length);
    }
    res.writeHead(status, allHeaders);
    res.end(body ?? undefined);
  };
  const json = (status: number, value: unknown, extra: Record<string, string> = {}): void => {
    jsonReply(send, status, value, extra);
  };
  const err = (status: number, message: string): void => errorReply(send, status, message);

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return err(400, 'Bad Request');
  }
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Health probe — no auth.
  if (method === 'GET' && path === '/healthz') {
    return json(200, { ok: true });
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    if (!authorized(req)) return err(401, 'Bad credentials');
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const action = gitMatch[3];
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return err(404, 'Not Found');
    const body = await readBody(req);
    try {
      if (method === 'GET' && action === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service === 'git-upload-pack') {
          const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          if (v2) {
            // Each capability is its own packet line in a v2 advertisement.
            const caps = [`agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
            const chunks = [
              servicePreamble('git-upload-pack'),
              pktLine('version 2\n'),
              ...caps.map((cap) => pktLine(`${cap}\n`)),
              FLUSH,
            ];
            return send(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }, Buffer.concat(chunks));
          }
          const chunks = [servicePreamble('git-upload-pack'), v0Advertisement(repo, V0_UPLOAD_CAPS)];
          return send(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }, Buffer.concat(chunks));
        }
        if (service === 'git-receive-pack') {
          const chunks = [servicePreamble('git-receive-pack'), v0Advertisement(repo, RECEIVE_CAPS)];
          return send(200, { 'content-type': 'application/x-git-receive-pack-advertisement' }, Buffer.concat(chunks));
        }
        return err(400, 'service parameter is required');
      }
      if (method === 'POST' && action === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        if (!v2) return err(400, 'Only protocol version 2 is supported for upload-pack');
        let parsed: { command: string; args: string[] };
        try {
          parsed = parseV2Request(body);
        } catch {
          return err(400, 'Malformed request');
        }
        if (parsed.command === 'ls-refs') {
          const lsReq: LsRefsRequest = { peel: false, symrefs: false, unborn: false, refPrefix: [] };
          for (const arg of parsed.args) {
            if (arg === 'peel') lsReq.peel = true;
            else if (arg === 'symrefs') lsReq.symrefs = true;
            else if (arg === 'unborn') lsReq.unborn = true;
            else if (arg.startsWith('ref-prefix ')) lsReq.refPrefix.push(arg.slice('ref-prefix '.length));
          }
          const out = lsRefsResponse(repo, lsReq);
          return send(200, { 'content-type': 'application/x-git-upload-pack-result' }, out);
        }
        if (parsed.command === 'fetch') {
          const fetchReq: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, ofsDelta: false };
          for (const arg of parsed.args) {
            if (arg.startsWith('want ')) fetchReq.wants.push(arg.slice(5));
            else if (arg.startsWith('have ')) fetchReq.haves.push(arg.slice(5));
            else if (arg.startsWith('shallow ')) fetchReq.shallow.push(arg.slice(8));
            else if (arg.startsWith('deepen ')) fetchReq.depth = Number.parseInt(arg.slice(7), 10);
            else if (arg === 'thin-pack') fetchReq.thinPack = true;
            else if (arg === 'ofs-delta') fetchReq.ofsDelta = true;
          }
          const out = fetchResponse(repo, fetchReq);
          return send(200, { 'content-type': 'application/x-git-upload-pack-result' }, out);
        }
        return err(400, `Unknown command ${parsed.command}`);
      }
      if (method === 'POST' && action === 'git-receive-pack') {
        let parsed;
        try {
          parsed = parsePushBody(body);
        } catch {
          return err(400, 'Malformed request');
        }
        let packObjects: { oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[] = [];
        if (parsed.pack) {
          try {
            packObjects = readPack(repo, parsed.pack);
          } catch {
            const results = parsed.commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }));
            return send(200, { 'content-type': 'application/x-git-receive-pack-result' }, pushResponse(results));
          }
        }
        const results = applyPush(forge, repo, parsed.commands, packObjects);
        return send(200, { 'content-type': 'application/x-git-receive-pack-result' }, pushResponse(results));
      }
      return err(404, 'Not Found');
    } catch (e) {
      // A git handler must never crash the server: the suite checks the
      // server is still healthy after malformed input.
      return err(400, e instanceof Error ? e.message : 'Bad Request');
    }
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') return err(405, 'Method Not Allowed');
    if (!authorized(req)) return err(401, 'Bad credentials');
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return json(400, { errors: [{ message: 'Problems parsing JSON' }] });
    }
    const result = handleGraphQL(forge, parsed);
    return json(200, result);
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      if (!authorized(req)) return err(401, 'Bad credentials');
      return send(204, {}, null);
    }
    if (method !== 'POST') return err(405, 'Method Not Allowed');
    if (!authorized(req)) return err(401, 'Bad credentials');
    const body = await readBody(req);
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(body.toString('utf8')) as JsonRpcRequest;
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    const { status, body: result } = handleMcp(forge, parsed);
    if (result === null) return send(status, {}, null);
    return json(status, result);
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (path === '/api/v3/' || path === '/api/v3/meta') {
      // Root and meta are unauthenticated, like GitHub.
    } else if (!authorized(req)) {
      return err(401, 'Bad credentials');
    }
    const body = await readBody(req);
    const ctx = {
      method,
      path,
      query: url.searchParams,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      json: null as unknown,
      params: {} as Record<string, string>,
      host: req.headers.host ?? 'localhost',
    };
    const handled = handleRest(forge, ctx, send);
    if (!handled) return err(404, 'Not Found');
    return;
  }

  return err(404, 'Not Found');
}
