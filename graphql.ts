// graphql.ts — a small GraphQL v4 implementation for POST /api/graphql.
//
// A hand-written tokenizer + recursive-descent parser for the documents the
// suite sends (queries, mutations, variables, aliases, inline fragments,
// input objects, enums, batched requests), and an executor over the same
// in-memory Forge the REST layer uses. Unknown fields produce a GraphQL
// error naming the field, with HTTP 200, exactly as GitHub does.

import {
  Forge,
  Repo,
  VIEWER_LOGIN,
  VIEWER_ID,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'spread'; value: '...' }
  | { kind: 'eof'; value: '' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: 'var', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]!:&|=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j++;
      const raw = input.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: Number.parseFloat(raw) });
      else tokens.push({ kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selection: SelectionNode[] };

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t)}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        const kind = t.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, variables, selection });
      } else if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        // Named fragments are not used by the suite; skip the definition.
        this.next();
        this.expectName();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          this.expectName();
        }
        this.parseSelectionSet();
      } else {
        throw new Error(`unexpected token ${JSON.stringify(t)} at document top level`);
      }
    }
    return operations;
  }

  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const varToken = this.next();
        if (varToken.kind !== 'var') throw new Error('expected variable in definition');
        names.push(varToken.value);
        this.expectPunct(':');
        // Type: name, with optional [] and ! — consume tokens until ',' or ')'.
        let depth = 0;
        for (;;) {
          const t = this.peek();
          if (t.kind === 'punct' && t.value === '[') depth++;
          if (t.kind === 'punct' && t.value === ']') depth--;
          if (depth === 0 && t.kind === 'punct' && (t.value === ',' || t.value === ')')) break;
          if (t.kind === 'eof') break;
          this.next();
        }
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(')');
    }
    return names;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const t = this.peek();
      if (t.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          // Named fragment spread: the suite does not use these.
          this.expectName();
          selections.push({ kind: 'fragment', typeCondition: null, selection: [] });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args = this.parseArguments();
      let selection: SelectionNode[] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseArguments(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args[name] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'variable', name: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// Resolve a parsed value against the request variables.
export function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema knowledge (field sets for validation and introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'isPrivate', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'createdAt', 'updatedAt', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'createdAt', 'updatedAt',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequestFile: ['path'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  Ref: ['name', 'target'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'ORGANIZATION'];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface GqlParent {
  __typename: string;
  [key: string]: unknown;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

function connectionOf<T>(items: T[], args: Record<string, unknown>): { nodes: T[]; pageInfo: GqlParent; totalCount: number } {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const afterIndex = cursorIndex(args.after as string | null | undefined);
  const start = afterIndex + 1;
  const page = items.slice(start, start + first);
  const lastIndex = start + page.length - 1;
  return {
    nodes: page,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: lastIndex + 1 < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor: page.length > 0 ? cursorFor(lastIndex) : null,
    },
    totalCount: items.length,
  };
}

class Executor {
  private errors: { message: string }[] = [];
  private forge: Forge;
  constructor(forge: Forge) {
    this.forge = forge;
  }

  execute(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
    const root: GqlParent = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const data = this.resolveSelection(root, operation.selection, variables);
    if (this.errors.length > 0) {
      return { data: data as Record<string, unknown> | null, errors: this.errors };
    }
    return { data: data as Record<string, unknown> };
  }

  private resolveSelection(parent: GqlParent, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
        const nested = this.resolveSelection(parent, sel.selection, variables);
        if (nested) Object.assign(out, nested);
        continue;
      }
      const field = sel.field;
      const key = field.alias ?? field.name;
      const value = this.resolveField(parent, field, variables);
      out[key] = value;
    }
    return out;
  }

  private unknownField(parent: GqlParent, field: FieldNode): null {
    this.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
    return null;
  }

  private resolveField(parent: GqlParent, field: FieldNode, variables: Record<string, unknown>): unknown {
    const known = TYPE_FIELDS[parent.__typename];
    if (known && !known.includes(field.name)) return this.unknownField(parent, field);
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables);
    const value = this.fieldValue(parent, field.name, args);
    if (value === undefined) return this.unknownField(parent, field);
    if (field.selection.length === 0) return value;
    if (value === null) return null;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          return this.resolveSelection(item as GqlParent, field.selection, variables);
        }
        return item;
      });
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      return this.resolveSelection(value as GqlParent, field.selection, variables);
    }
    return value;
  }

  private fieldValue(parent: GqlParent, name: string, args: Record<string, unknown>): unknown {
    switch (parent.__typename) {
      case 'Query':
        return this.queryField(name, args);
      case 'Mutation':
        return this.mutationField(name, args);
      case 'User':
        return this.userField(parent, name);
      case 'Repository':
        return this.repositoryField(parent, name, args);
      case 'Issue':
        return this.issueField(parent, name);
      case 'PullRequest':
        return this.pullField(parent, name, args);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'IssueCommentConnection':
      case 'FileConnection': {
        if (name === 'nodes') return parent.nodes;
        if (name === 'pageInfo') return parent.pageInfo;
        if (name === 'totalCount') return parent.totalCount;
        if (name === 'edges') {
          return (parent.nodes as GqlParent[]).map((node, i) => ({ __typename: `${parent.__typename.replace('Connection', '')}Edge`, node, cursor: cursorFor(i) }));
        }
        return undefined;
      }
      case 'PageInfo':
        return parent[name];
      case 'IssueComment':
        return parent[name];
      case 'PullRequestFile':
        return parent[name];
      case '__Type':
        return this.typeField(parent, name, args);
      case '__Field':
      case '__EnumValue':
        return parent[name];
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
      case 'AddCommentPayload':
        return parent[name];
      case 'IssueCommentEdge':
        return parent[name];
      case 'Ref':
        return parent[name];
      default:
        return undefined;
    }
  }

  private queryField(name: string, args: Record<string, unknown>): unknown {
    if (name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' };
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = this.forge.getRepo(owner, repoName);
      return repo ? repoParent(repo) : null;
    }
    if (name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = [...this.forge.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        return repo ? repoParent(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const repo = [...this.forge.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
        return issue && repo ? issueParent(repo, issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const repo = [...this.forge.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
        const pull = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
        return pull && repo ? pullParent(repo, pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (typeName === 'SearchType') {
        return {
          __typename: '__Type',
          name: 'SearchType',
          kind: 'ENUM',
          fields: null,
          enumValues: SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
        };
      }
      const fields = TYPE_FIELDS[typeName];
      if (!fields) return null;
      return {
        __typename: '__Type',
        name: typeName,
        kind: 'OBJECT',
        fields: fields.map((f) => ({ __typename: '__Field', name: f, description: null, args: [] })),
        enumValues: null,
      };
    }
    if (name === '__schema') {
      return { __typename: '__Schema', types: [], queryType: null, mutationType: null };
    }
    return undefined;
  }

  private mutationField(name: string, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = repoFromGlobalId(this.forge, String(input.repositoryId ?? ''));
      if (!repo) {
        this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const issue = this.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueParent(repo, issue) };
    }
    if (name === 'closeIssue') {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed || parsed.kind !== 'Issue') {
        this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      const repo = [...this.forge.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
      if (!repo || !issue) {
        this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueParent(repo, issue) };
    }
    if (name === 'createPullRequest') {
      const repo = repoFromGlobalId(this.forge, String(input.repositoryId ?? ''));
      if (!repo) {
        this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.getRef(`refs/heads/${head}`);
      const baseSha = repo.getRef(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        this.errors.push({ message: 'Head or base branch does not exist.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headBranch === head && p.baseBranch === base);
      if (dup) {
        this.errors.push({ message: 'A pull request already exists for these branches.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const pull = this.forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base, headSha, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullParent(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'PullRequest') {
        this.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const repo = [...this.forge.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
      const pull = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
      if (!repo || !pull) {
        this.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      if (pull.merged || pull.state === 'closed') {
        this.errors.push({ message: 'Pull request is already closed.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: pullParent(repo, pull) };
      }
      const result = this.forge.squashMerge(repo, pull);
      if ('conflict' in result) {
        this.errors.push({ message: 'Merge conflict.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = result.commitOid;
      return { __typename: 'MergePullRequestPayload', pullRequest: pullParent(repo, pull) };
    }
    if (name === 'addComment') {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || parsed.kind !== 'Issue') {
        this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const repo = [...this.forge.repos.values()].find((r) => r.id === Number(parsed.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
      if (!repo || !issue) {
        this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const comment = this.forge.addComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body },
          cursor: cursorFor(issue.comments.length - 1),
        },
      };
    }
    return undefined;
  }

  private userField(parent: GqlParent, name: string): unknown {
    if (name === 'login') return parent.login;
    if (name === 'id') return globalId('User', VIEWER_ID);
    if (name === 'name') return parent.name;
    if (name === 'email') return parent.email;
    return undefined;
  }

  private repositoryField(parent: GqlParent, name: string, args: Record<string, unknown>): unknown {
    const repo = parent.__repo as Repo;
    switch (name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        return { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' };
      case 'defaultBranchRef': {
        const tip = repo.headOid();
        if (!tip) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, target: tip };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? issueParent(repo, issue) : null;
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.direction === 'DESC') issues = issues.reverse();
        const conn = connectionOf(issues.map((i) => issueParent(repo, i)), args);
        return { __typename: 'IssueConnection', ...conn };
      }
      case 'pullRequests': {
        const conn = connectionOf(repo.pulls.map((p) => pullParent(repo, p)), args);
        return { __typename: 'PullRequestConnection', ...conn };
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return pull ? pullParent(repo, pull) : null;
      }
      case 'url':
        return `https://github.com/${repo.fullName}`;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'createdAt':
      case 'updatedAt':
        return '2026-01-01T00:00:00Z';
      default:
        return undefined;
    }
  }

  private issueField(parent: GqlParent, name: string): unknown {
    const issue = parent.__issue as Issue;
    switch (name) {
      case 'id':
        return parent.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'url':
        return `https://github.com/issues/${issue.number}`;
      case 'author':
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
      case 'createdAt':
      case 'updatedAt':
        return '2026-01-01T00:00:00Z';
      case 'comments': {
        const repo = parent.__repo as Repo;
        const conn = connectionOf(
          issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('IssueComment', repo.id, issue.number, c.id), body: c.body })),
          {},
        );
        return { __typename: 'IssueCommentConnection', ...conn };
      }
      default:
        return undefined;
    }
  }

  private pullField(parent: GqlParent, name: string, args: Record<string, unknown>): unknown {
    const pull = parent.__pull as Pull;
    const repo = parent.__repo as Repo;
    switch (name) {
      case 'id':
        return parent.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return pull.body;
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headBranch;
      case 'baseRefName':
        return pull.baseBranch;
      case 'mergeable': {
        const headTip = repo.getRef(`refs/heads/${pull.headBranch}`);
        const baseTip = repo.getRef(`refs/heads/${pull.baseBranch}`);
        if (!headTip || !baseTip) return 'UNKNOWN';
        const base = repo.mergeBase(headTip, baseTip);
        const baseTree = base ? repo.commitTree(base) : '';
        const headTree = repo.commitTree(headTip);
        const baseTipTree = repo.commitTree(baseTip);
        const headChanges = repo.diffTrees(baseTree, headTree);
        const baseChanges = repo.diffTrees(baseTree, baseTipTree);
        const baseChanged = new Map<string, string | null>();
        for (const c of baseChanges) baseChanged.set(c.path, c.newOid);
        for (const c of headChanges) {
          if (baseChanged.has(c.path) && baseChanged.get(c.path) !== c.newOid) return 'CONFLICTING';
        }
        return 'MERGEABLE';
      }
      case 'files': {
        const headTip = repo.getRef(`refs/heads/${pull.headBranch}`) ?? pull.headSha;
        const baseTip = repo.getRef(`refs/heads/${pull.baseBranch}`) ?? pull.baseSha;
        const base = repo.mergeBase(headTip, baseTip);
        const baseTree = base ? repo.commitTree(base) : '';
        const headTree = repo.commitTree(headTip);
        const diff = repo.diffTrees(baseTree, headTree);
        const conn = connectionOf(
          diff.map((d) => ({ __typename: 'PullRequestFile', path: d.path })),
          args,
        );
        return { __typename: 'FileConnection', ...conn };
      }
      case 'author':
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
      case 'createdAt':
      case 'updatedAt':
        return '2026-01-01T00:00:00Z';
      default:
        return undefined;
    }
  }

  private typeField(parent: GqlParent, name: string, args: Record<string, unknown>): unknown {
    if (name === 'name') return parent.name;
    if (name === 'kind') return parent.kind;
    if (name === 'description') return parent.description ?? null;
    if (name === 'fields') {
      const includeDeprecated = args.includeDeprecated === true;
      void includeDeprecated;
      return parent.fields ?? null;
    }
    if (name === 'enumValues') {
      const includeDeprecated = args.includeDeprecated === true;
      void includeDeprecated;
      return parent.enumValues ?? null;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parent object builders
// ---------------------------------------------------------------------------

export function repoParent(repo: Repo): GqlParent {
  return { __typename: 'Repository', __repo: repo };
}

export function issueParent(repo: Repo, issue: Issue): GqlParent {
  return { __typename: 'Issue', __repo: repo, __issue: issue, id: globalId('Issue', repo.id, issue.number) };
}

export function pullParent(repo: Repo, pull: Pull): GqlParent {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull, id: globalId('PullRequest', repo.id, pull.number) };
}

function repoFromGlobalId(forge: Forge, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return [...forge.repos.values()].find((r) => r.id === Number(parsed.parts[0])) ?? null;
}

// ---------------------------------------------------------------------------
// Entry point: handle one parsed GraphQL request body.
// ---------------------------------------------------------------------------

export function handleGraphQL(forge: Forge, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(forge, item));
  }
  return executeOne(forge, body);
}

function executeOne(forge: Forge, body: unknown): Record<string, unknown> {
  const doc = body as { query?: string; variables?: Record<string, unknown>; operationName?: string | null };
  if (!doc || typeof doc.query !== 'string') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(doc.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `GraphQL syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const variables = (doc.variables ?? {}) as Record<string, unknown>;
  let operation = operations[0];
  if (doc.operationName) {
    const named = operations.find((op) => op.name === doc.operationName);
    if (named) operation = named;
  }
  if (!operation) return { errors: [{ message: 'Must provide an operation.' }] };
  const executor = new Executor(forge);
  return executor.execute(operation, variables);
}
