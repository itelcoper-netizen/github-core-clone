// gitproto.ts — the git smart HTTP protocol.
//
// Packet-line framing, packfile reading and writing (plain objects plus
// OFS/REF deltas), the v0 and v2 upload-pack advertisements, ls-refs and
// fetch, and the receive-pack push path with fast-forward validation.
// Everything here works on Buffers; the server never shells out to git.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  Forge,
  Repo,
  ZERO_OID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  parseTag,
  parseTree,
  hashObject,
  type GitObjectType,
} from './store.ts';

export const AGENT = 'github-core-clone/1.0';

// ---------------------------------------------------------------------------
// Packet lines
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export class PktReader {
  private pos = 0;
  private buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  // Reads one packet. Returns null on flush (0000), 'delim' on 0001, or the
  // payload Buffer. Throws on a malformed length prefix.
  read(): Buffer | null | 'delim' {
    if (this.pos + 4 > this.buf.length) throw new Error('truncated pkt-line');
    const header = this.buf.toString('ascii', this.pos, this.pos + 4);
    const len = parseInt(header, 16);
    if (Number.isNaN(len)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    if (len === 0) {
      this.pos += 4;
      return null;
    }
    if (len === 1) {
      this.pos += 4;
      return 'delim';
    }
    if (len < 4 || this.pos + len > this.buf.length) throw new Error('pkt-line overruns input');
    const payload = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return payload;
  }

  // Bytes remaining after the last packet read.
  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }

  get offset(): number {
    return this.pos;
  }
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packEntryHeader(typeCode: number, size: number): Buffer {
  const first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  const bytes: number[] = [];
  if (size === 0) {
    bytes.push(first);
  } else {
    bytes.push(first | 0x80);
    while (size > 0) {
      const chunk = size & 0x7f;
      size >>= 7;
      bytes.push(size === 0 ? chunk : chunk | 0x80);
    }
  }
  return Buffer.from(bytes);
}

export function writePack(entries: { type: GitObjectType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) {
    const deflated = deflateSync(entry.data);
    parts.push(packEntryHeader(TYPE_CODES[entry.type], entry.data.length));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Parse a pack, resolving deltas against objects already in the store and
// objects earlier in the same pack. Returns the objects in pack order.
export function readPack(repo: Repo, pack: Buffer): { oid: string; type: GitObjectType; data: Buffer }[] {
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const out: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = pack[pos++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: variable-length negative offset.
      let b = pack[pos++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { data: inflatedData, consumed } = inflateEntry(pack, pos, size);
    pos += consumed;
    let type: GitObjectType;
    let data: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      const base = baseOffset !== undefined ? byOffset.get(baseOffset) : repo.getObject(baseOid!);
      if (!base) throw new Error('delta base not found');
      if (base.type !== 'commit' && base.type !== 'tree' && base.type !== 'blob' && base.type !== 'tag') {
        throw new Error('bad delta base type');
      }
      data = applyDelta(base.data, inflatedData);
      type = base.type;
    } else {
      type = PACK_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      data = inflatedData;
    }
    if (data.length !== size) throw new Error('object size mismatch in pack');
    const oid = hashObject(type, data);
    const entry = { oid, type, data };
    byOffset.set(start, entry);
    out.push(entry);
  }
  // Verify the trailer checksum.
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!expected.equals(pack.subarray(pack.length - 20))) throw new Error('pack checksum mismatch');
  return out;
}

// Adler-32, the checksum that ends every zlib stream.
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Inflate the zlib stream starting at `pos` and report how many input
// bytes it consumed. Node's inflateSync ignores trailing bytes, so one call
// inflates the entry; the stream's end is then located by scanning for the
// Adler-32 checksum of the inflated data (the last four bytes of a zlib
// stream), verified by re-inflating exactly up to that point. Two inflate
// calls per entry instead of a binary search's half-dozen.
function inflateEntry(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; consumed: number } {
  const data = inflateSync(buf.subarray(pos));
  if (data.length !== expectedSize) throw new Error('object size mismatch in pack');
  const checksum = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(checksum, 0);
  let searchFrom = pos + 2;
  for (;;) {
    const at = buf.indexOf(needle, searchFrom);
    if (at === -1) throw new Error('could not find zlib stream end');
    const end = at + 4;
    try {
      const check = inflateSync(buf.subarray(pos, end));
      if (check.length === expectedSize && check.equals(data)) {
        return { data, consumed: end - pos };
      }
    } catch {
      // The checksum bytes appeared inside the deflate data; keep scanning.
    }
    searchFrom = at + 1;
  }
}

// Apply a git binary delta to a base buffer.
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (pos < delta.length) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// ---------------------------------------------------------------------------
// Ref advertisement helpers
// ---------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

// All refs of a repo, sorted the way git advertises them (HEAD first, then
// heads, then tags), with peeled lines for annotated tags.
export function advertisedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.getRef(defaultRef);
  if (defaultTip) {
    out.push({ oid: defaultTip, name: 'HEAD', symrefTarget: defaultRef });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef });
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, oid] of refs) {
    out.push({ oid, name });
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      out.push({ oid: target, name: `${name}^{}` });
    }
  }
  return out;
}

// v0 advertisement body (without the service preamble).
export function v0Advertisement(repo: Repo, caps: string): Buffer {
  const refs = advertisedRefs(repo);
  const chunks: Buffer[] = [];
  const isEmpty = refs.length === 1 && refs[0].oid === ZERO_OID;
  if (isEmpty) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) {
        chunks.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
      } else if (ref.name.endsWith('^{}')) {
        chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
      } else {
        chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
      }
    });
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

export function servicePreamble(service: string): Buffer {
  return pktLine(`# service=${service}\n`);
}

// ---------------------------------------------------------------------------
// v2 protocol
// ---------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  refPrefix: string[];
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  ofsDelta: boolean;
}

export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const reader = new PktReader(body);
  const first = reader.read();
  if (!first || first === 'delim') throw new Error('missing v2 command');
  const commandLine = first.toString('utf8').trim();
  const match = /^command=(\S+)$/.exec(commandLine);
  if (!match) throw new Error(`bad v2 command line ${JSON.stringify(commandLine)}`);
  const args: string[] = [];
  for (;;) {
    const packet = reader.read();
    if (packet === null) break;
    // Delim packets separate the command section from the argument section;
    // arguments may appear on either side, so keep collecting past them.
    if (packet === 'delim') continue;
    args.push(packet.toString('utf8').trim());
  }
  return { command: match[1], args };
}

export function lsRefsResponse(repo: Repo, req: LsRefsRequest): Buffer {
  const chunks: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.getRef(defaultRef);
  // HEAD is only reported when no ref-prefix filters it out (or when a
  // prefix matches HEAD itself, as in a plain `git ls-refs`).
  const headVisible = req.refPrefix.length === 0 || req.refPrefix.some((p) => 'HEAD'.startsWith(p));
  if (headVisible && defaultTip) {
    let line = `${defaultTip} HEAD`;
    if (req.symrefs) line += ` symref-target:${defaultRef}`;
    chunks.push(pktLine(`${line}\n`));
  } else if (headVisible && req.unborn) {
    let line = `unborn HEAD`;
    if (req.symrefs) line += ` symref-target:${defaultRef}`;
    chunks.push(pktLine(`${line}\n`));
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, oid] of refs) {
    if (req.refPrefix.length > 0 && !req.refPrefix.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (req.symrefs && name === defaultRef) line += ` symref-target:${defaultRef}`;
    if (req.peel) {
      const obj = repo.getObject(oid);
      if (obj && obj.type === 'tag') {
        line += ` peeled:${parseTag(obj.data).object}`;
      }
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// Compute the fetch answer: which objects to send, the new shallow
// boundaries, and the old boundaries that are now unshallow.
export function planFetch(
  repo: Repo,
  req: FetchRequest,
): { objects: { type: GitObjectType; data: Buffer }[]; shallow: string[]; unshallow: string[]; ack: string | null } {
  const haveReachable = repo.reachableCutoff(req.haves, new Set(req.shallow));
  // The acknowledgement only matters when the client sent haves, and the
  // included set only needs the full reachable closure for an unshallow
  // fetch. A depth-limited fetch with no haves (a fresh shallow clone)
  // needs neither, so skip the full-history walk entirely there.
  const needWantReachable = req.haves.length > 0 || req.depth === null;
  const wantReachable = needWantReachable ? repo.reachable(req.wants) : new Set<string>();

  // Commits to include, honoring depth. Depth counts generations from a
  // want: depth 1 means only the want commits themselves.
  const included = new Set<string>();
  if (req.depth === null) {
    for (const oid of wantReachable) {
      const obj = repo.getObject(oid);
      if (obj && obj.type === 'commit') included.add(oid);
    }
  } else {
    const queue: { oid: string; depth: number }[] = req.wants.map((oid) => ({ oid, depth: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const parsed = repo.parsedCommit(oid);
      if (!parsed) continue;
      included.add(oid);
      if (depth + 1 < req.depth) {
        for (const p of parsed.parents) queue.push({ oid: p, depth: depth + 1 });
      }
    }
  }

  // Objects to send: everything reachable from the included commits (plus
  // non-commit wants such as tags) that the client does not already have.
  // The walk only follows parents through included commits, so a shallow
  // fetch sends just its own depth of history, not the whole repository.
  const sendRoots: string[] = [...included];
  for (const want of req.wants) {
    const obj = repo.getObject(want);
    if (obj && obj.type === 'tag') {
      sendRoots.push(want);
      const target = parseTag(obj.data).object;
      const targetObj = repo.getObject(target);
      if (targetObj && targetObj.type === 'commit') included.add(target);
    } else if (obj && obj.type !== 'commit') {
      sendRoots.push(want);
    }
  }
  const sendable = new Set<string>();
  {
    const stack: string[] = [...sendRoots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (sendable.has(oid) || oid === ZERO_OID) continue;
      const obj = repo.getObject(oid);
      if (!obj) continue;
      sendable.add(oid);
      if (obj.type === 'commit') {
        const parsed = repo.parsedCommit(oid)!;
        stack.push(parsed.tree);
        for (const p of parsed.parents) {
          if (included.has(p)) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const objects: { type: GitObjectType; data: Buffer }[] = [];
  const sent = new Set<string>();
  for (const oid of sendable) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (!obj) continue;
    sent.add(oid);
    objects.push({ type: obj.type, data: obj.data });
  }

  // New shallow boundaries: sent commits whose parents are neither sent nor
  // already held by the client.
  const shallow: string[] = [];
  if (req.depth !== null) {
    for (const oid of included) {
      if (!sent.has(oid)) continue;
      const parsed = repo.parsedCommit(oid);
      if (!parsed) continue;
      const parents = parsed.parents;
      if (parents.length === 0) {
        shallow.push(oid);
      } else if (parents.every((p) => !sent.has(p) && !haveReachable.has(p))) {
        shallow.push(oid);
      }
    }
  }

  // Old boundaries that are now unshallow: every parent of the boundary is
  // now sent or already held.
  const unshallow: string[] = [];
  for (const boundary of req.shallow) {
    const parsed = repo.parsedCommit(boundary);
    if (!parsed) continue;
    const parents = parsed.parents;
    if (parents.every((p) => sent.has(p) || haveReachable.has(p))) unshallow.push(boundary);
  }

  // Acknowledgement: the first have that is an ancestor of a want.
  let ack: string | null = null;
  for (const have of req.haves) {
    if (wantReachable.has(have)) {
      ack = have;
      break;
    }
  }
  return { objects, shallow, unshallow, ack };
}

export function fetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  if (plan.ack) {
    chunks.push(pktLine(`ACK ${plan.ack}\n`));
    chunks.push(pktLine('ready\n'));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  chunks.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(DELIM);
  }
  chunks.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  // Sideband: band 1 carries the pack, chunked so no packet exceeds 64 KiB.
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const packet = reader.read();
    if (packet === null) break;
    if (packet === 'delim') break;
    const line = packet.toString('utf8').trim();
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length < 3) throw new Error(`bad push command line ${JSON.stringify(clean)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const rest = reader.rest();
  return { commands, pack: rest.length > 0 ? rest : null };
}

export function applyPush(
  forge: Forge,
  repo: Repo,
  commands: PushCommand[],
  packObjects: { oid: string; type: GitObjectType; data: Buffer }[],
): { ref: string; ok: boolean; reason?: string }[] {
  for (const obj of packObjects) {
    if (!repo.hasObject(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const cmd of commands) {
    const current = repo.getRef(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      repo.deleteRef(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    const newObj = repo.getObject(cmd.newOid);
    if (!newObj) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!current) {
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      repo.setRef(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    // Fast-forward check for branch updates.
    if (cmd.ref.startsWith('refs/heads/')) {
      const ancestors = repo.ancestors(cmd.newOid);
      if (!ancestors.has(current)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.setRef(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  void forge;
  return results;
}

export function pushResponse(results: { ref: string; ok: boolean; reason?: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const report = (line: string): Buffer => pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]));
  chunks.push(report('unpack ok\n'));
  for (const r of results) {
    if (r.ok) chunks.push(report(`ok ${r.ref}\n`));
    else chunks.push(report(`ng ${r.ref} ${r.reason ?? 'failed'}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}
