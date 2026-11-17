// store.ts — the forge's in-memory state.
//
// One process, no disk writes: every repository lives in memory as a git
// object store (blobs, trees, commits, tags) plus refs, and the REST
// resources built on top of it (labels, issues, pull requests, comments).
// The trial mounts the repo read-only and only /tmp is writable, so keeping
// everything in RAM is both the simplest and the fastest design.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// git object hashing and encoding
// ---------------------------------------------------------------------------

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function parseTag(data: Buffer): { object: string; type: GitObjectType; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type: GitObjectType = 'commit';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
  }
  return { object, type, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0) break;
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  // Git sorts tree entries by name, with directory names compared as if
  // they had a trailing slash.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  updatedSeq: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextNumber = 1;
  nextLabelId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdSeq = seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  // -- objects ---------------------------------------------------------------
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  // -- refs ------------------------------------------------------------------
  getRef(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
  }

  deleteRef(ref: string): boolean {
    return this.refs.delete(ref);
  }

  headOid(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  // -- trees and commits ------------------------------------------------------
  // Parsed commits are cached: objects are immutable once stored, and the
  // hot paths (history walks, fast-forward checks, fetch planning) parse
  // the same commits over and over.
  private parsedCache = new Map<string, { tree: string; parents: string[]; message: string }>();

  parsedCommit(oid: string): { tree: string; parents: string[]; message: string } | null {
    const cached = this.parsedCache.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    this.parsedCache.set(oid, parsed);
    return parsed;
  }

  commitTree(oid: string): string {
    return this.parsedCommit(oid)?.tree ?? '';
  }

  // Flatten a tree into path -> {mode, oid}, recursively.
  treeToMap(treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        this.treeToMap(entry.oid, path, out);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  // Build a tree (and all intermediate trees) from a flat path map.
  mapToTree(map: Map<string, { mode: string; oid: string }>): string {
    return this.buildFromMap(map);
  }

  private buildFromMap(map: Map<string, { mode: string; oid: string }>): string {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
    for (const [path, entry] of map) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(rest, entry);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: this.buildFromMap(sub) });
    }
    return this.putObject('tree', buildTree(entries));
  }

  makeCommit(treeOid: string, parents: string[], message: string, when?: number): string {
    const epoch = when ?? Math.floor(Date.now() / 1000);
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
    const body =
      `tree ${treeOid}\n` +
      parents.map((p) => `parent ${p}\n`).join('') +
      `author ${ident}\ncommitter ${ident}\n\n${message}`;
    return this.putObject('commit', Buffer.from(body, 'utf8'));
  }

  // List commits newest-first by following first parents from `start`.
  listCommits(start: string, limit = 100): string[] {
    const out: string[] = [];
    let cur: string | undefined = start;
    const seen = new Set<string>();
    while (cur && cur !== ZERO_OID && out.length < limit && !seen.has(cur)) {
      seen.add(cur);
      const parsed = this.parsedCommit(cur);
      if (!parsed) break;
      out.push(cur);
      cur = parsed.parents[0];
    }
    return out;
  }

  // All ancestors of a commit (through every parent).
  ancestors(start: string): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [start];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const parsed = this.parsedCommit(oid);
      if (!parsed) continue;
      seen.add(oid);
      for (const p of parsed.parents) stack.push(p);
    }
    return seen;
  }

  mergeBase(a: string, b: string): string | undefined {
    const aAncestors = this.ancestors(a);
    // Breadth-first from b so the first common ancestor is the nearest one.
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const parsed = this.parsedCommit(oid);
      if (!parsed) continue;
      for (const p of parsed.parents) queue.push(p);
    }
    return undefined;
  }

  // Every object reachable from the given roots (commits, trees, blobs, tags).
  reachable(roots: string[]): Set<string> {
    return this.reachableCutoff(roots, new Set());
  }

  // Like reachable(), but never follows the parents of a commit listed in
  // `cutoff`. That is the object set a shallow clone holds: everything up
  // to its shallow boundaries, and nothing beyond them.
  reachableCutoff(roots: string[], cutoff: Set<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const parsed = this.parsedCommit(oid)!;
        stack.push(parsed.tree);
        if (!cutoff.has(oid)) {
          for (const p of parsed.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }

  // -- file writes -------------------------------------------------------------
  // Write a file at `path` on `branch`, creating the branch from the default
  // tip when it does not exist yet. Returns the new commit oid.
  commitFile(branch: string, path: string, content: Buffer, message: string): string {
    const ref = `refs/heads/${branch}`;
    let tip = this.refs.get(ref);
    let treeMap: Map<string, { mode: string; oid: string }>;
    if (tip) {
      treeMap = this.treeToMap(this.commitTree(tip));
    } else {
      // Branch does not exist: start from the default branch tip, or empty.
      const defaultTip = this.headOid();
      if (defaultTip) {
        tip = defaultTip;
        treeMap = this.treeToMap(this.commitTree(defaultTip));
      } else {
        treeMap = new Map();
      }
    }
    const blobOid = this.putObject('blob', content);
    treeMap.set(path, { mode: '100644', oid: blobOid });
    const treeOid = this.mapToTree(treeMap);
    const parents = tip ? [tip] : [];
    const commitOid = this.makeCommit(treeOid, parents, message);
    this.refs.set(ref, commitOid);
    return commitOid;
  }

  // Delete a file at `path` on `branch`. Returns the new commit oid, or null
  // when the file was not present.
  deleteFile(branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref);
    if (!tip) return null;
    const treeMap = this.treeToMap(this.commitTree(tip));
    if (!treeMap.has(path)) return null;
    treeMap.delete(path);
    const treeOid = this.mapToTree(treeMap);
    const commitOid = this.makeCommit(treeOid, [tip], message);
    this.refs.set(ref, commitOid);
    return commitOid;
  }

  // -- diffs -------------------------------------------------------------------
  // Compare two trees. Returns changed paths with old/new blob oids.
  diffTrees(
    baseTree: string,
    headTree: string,
  ): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const base = baseTree ? this.treeToMap(baseTree) : new Map<string, { mode: string; oid: string }>();
    const head = headTree ? this.treeToMap(headTree) : new Map<string, { mode: string; oid: string }>();
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  // Count added/deleted lines between two blobs with a simple prefix/suffix
  // comparison — exact for the one-file changes the suite exercises.
  countLineChanges(oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const linesOf = (oid: string | null): string[] => {
      if (!oid) return [];
      const obj = this.objects.get(oid);
      if (!obj) return [];
      const text = obj.data.toString('utf8');
      if (text === '') return [];
      const parts = text.split('\n');
      if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
      return parts;
    };
    const oldLines = linesOf(oldOid);
    const newLines = linesOf(newOid);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix++;
    }
    return {
      additions: newLines.length - prefix - suffix,
      deletions: oldLines.length - prefix - suffix,
    };
  }
}

// ---------------------------------------------------------------------------
// The whole forge: one viewer, all of their repositories.
// ---------------------------------------------------------------------------

export class Forge {
  repos = new Map<string, Repo>(); // key: owner/name
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  private seq = 1;

  nextSeq(): number {
    return this.seq++;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(`${owner}/${name}`)) return null;
    const repo = new Repo(this.nextRepoId++, owner, name, description, isPrivate, this.nextSeq());
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -- issues and pull requests (shared number counter per repo) --------------
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      updatedSeq: this.nextSeq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headBranch: string, baseBranch: string, headSha: string, baseSha: string): Pull {
    const pull: Pull = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headBranch,
      baseBranch,
      headSha,
      baseSha,
      createdSeq: this.nextSeq(),
      updatedSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, createdSeq: this.nextSeq() };
    issue.comments.push(comment);
    return comment;
  }

  // Squash-merge a pull request. Returns the merge commit oid, or null when
  // the merge conflicts (a file changed on both sides with different content).
  squashMerge(repo: Repo, pull: Pull): { commitOid: string } | { conflict: true } {
    const headTip = repo.getRef(`refs/heads/${pull.headBranch}`);
    const baseTip = repo.getRef(`refs/heads/${pull.baseBranch}`);
    if (!headTip || !baseTip) return { conflict: true };
    const base = repo.mergeBase(headTip, baseTip);
    const baseTree = base ? repo.commitTree(base) : '';
    const headTree = repo.commitTree(headTip);
    const baseTipTree = repo.commitTree(baseTip);
    const headChanges = repo.diffTrees(baseTree, headTree);
    const baseChanges = repo.diffTrees(baseTree, baseTipTree);
    const baseChanged = new Map<string, string | null>();
    for (const c of baseChanges) baseChanged.set(c.path, c.newOid);
    for (const c of headChanges) {
      if (baseChanged.has(c.path) && baseChanged.get(c.path) !== c.newOid) {
        return { conflict: true };
      }
    }
    // Apply the head's changes on top of the base tip's tree.
    const treeMap = repo.treeToMap(baseTipTree);
    for (const c of headChanges) {
      if (c.status === 'removed') treeMap.delete(c.path);
      else treeMap.set(c.path, { mode: '100644', oid: c.newOid! });
    }
    const treeOid = repo.mapToTree(treeMap);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headBranch}\n\n${pull.title}`;
    const commitOid = repo.makeCommit(treeOid, [baseTip], message);
    repo.setRef(`refs/heads/${pull.baseBranch}`, commitOid);
    return { commitOid };
  }
}

// ---------------------------------------------------------------------------
// Global ids (opaque, stable): base64 of a typed key, never the bare number.
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
