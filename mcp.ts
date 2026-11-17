// mcp.ts — the Model Context Protocol surface (POST /mcp).
//
// The legacy era only: `server/discover` is answered with -32601 so the
// client falls back to the pre-discover handshake, then `initialize`,
// `tools/list` and `tools/call` serve the six tools the suite requires.
// Tool calls delegate to the same Forge the REST layer uses.

import { Forge, Repo, VIEWER_LOGIN, VIEWER_ID, globalId } from './store.ts';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const KNOWN_REVISIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'object' && value !== null ? value : { result: value },
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function needRepo(forge: Forge, owner: unknown, repoName: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, repoName) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const repo = forge.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (!repo) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        description: repo.description,
        private: repo.isPrivate,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = needRepo(forge, args.owner, args.repo);
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult({
        id: repo.id,
        node_id: globalId('Repository', repo.id),
        name: repo.name,
        full_name: repo.fullName,
        owner: { login: repo.owner, id: VIEWER_ID },
        description: repo.description,
        private: repo.isPrivate,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = needRepo(forge, args.owner, args.repo);
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
      });
    }
    case 'list_issues': {
      const repo = needRepo(forge, args.owner, args.repo);
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const repo = needRepo(forge, args.owner, args.repo);
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.getRef(`refs/heads/${head}`);
      const baseSha = repo.getRef(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('Head or base branch does not exist');
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headBranch === head && p.baseBranch === base);
      if (dup) return toolError('A pull request already exists for these branches');
      const pull = forge.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headBranch, sha: pull.headSha },
        base: { ref: pull.baseBranch, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = needRepo(forge, args.owner, args.repo);
      if (!repo) return toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return toolError(`Pull request #${String(args.pull_number)} not found`);
      if (pull.merged || pull.state === 'closed') return toolError('Pull request is already closed');
      const result = forge.squashMerge(repo, pull);
      if ('conflict' in result) return toolError('Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = result.commitOid;
      return toolResult({
        merged: true,
        number: pull.number,
        state: pull.state,
        sha: result.commitOid,
        merge_commit_sha: result.commitOid,
      });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// Handle one parsed JSON-RPC message. Returns {status, body} where body is
// null for a 202 notification acknowledgement.
export function handleMcp(forge: Forge, request: JsonRpcRequest): { status: number; body: Record<string, unknown> | null } {
  const id = request.id ?? null;
  const method = request.method ?? '';

  // Notifications (no id) are acknowledged with an empty 202.
  if (request.id === undefined) {
    return { status: 202, body: null };
  }
  if (typeof method !== 'string' || method === '') {
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request: missing method') };
  }
  if (method === 'server/discover') {
    // The legacy era: report the method as unknown so the client falls back.
    return { status: 200, body: rpcError(id, -32601, 'Method not found: server/discover') };
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = KNOWN_REVISIONS.has(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tool name is required') };
    }
    if (!TOOLS.some((t) => t.name === toolName)) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: arguments must be an object') };
    }
    const result = callTool(forge, toolName, args);
    return { status: 200, body: rpcResult(id, result) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
