import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { IntegrityChain } from '../integrity.js';
import type { IntegrityRecord } from '../integrity.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh in-memory chain for each test. */
function makeChain(): IntegrityChain {
  return new IntegrityChain(':memory:');
}

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Build a minimal attribution payload. */
function payload(id: number): Record<string, unknown> {
  return { file: `src/file${id}.ts`, linesAdded: id * 10, tool: 'COPILOT', timestamp: 1_700_000_000 + id };
}

// ── Append and chain validity ─────────────────────────────────────────────────

describe('append + verify — valid chain', () => {
  let chain: IntegrityChain;

  beforeEach(() => { chain = makeChain(); });

  it('appends 5 records and verify() returns valid', () => {
    for (let i = 1; i <= 5; i++) chain.append(payload(i));
    const result = chain.verify();
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeNull();
    expect(result.totalRecords).toBe(5);
  });

  it('sequence numbers are 1-based and increment by 1', () => {
    const recs: IntegrityRecord[] = [];
    for (let i = 1; i <= 5; i++) recs.push(chain.append(payload(i)));
    expect(recs.map(r => r.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns valid with 0 records (empty chain)', () => {
    const result = chain.verify();
    expect(result.valid).toBe(true);
    expect(result.totalRecords).toBe(0);
  });

  it('returns valid with a single record', () => {
    chain.append(payload(1));
    expect(chain.verify().valid).toBe(true);
  });

  it('signature field is always null', () => {
    const rec = chain.append(payload(1));
    expect(rec.signature).toBeNull();
  });
});

// ── Genesis record ────────────────────────────────────────────────────────────

describe('genesis record', () => {
  it('first record has previousHash === "GENESIS"', () => {
    const chain = makeChain();
    const rec = chain.append(payload(1));
    expect(rec.previousHash).toBe('GENESIS');
  });

  it('second record previousHash equals first record chainHash', () => {
    const chain = makeChain();
    const first  = chain.append(payload(1));
    const second = chain.append(payload(2));
    expect(second.previousHash).toBe(first.chainHash);
  });

  it('chainHash of first record commits to sequenceNumber=1, contentHash, and "GENESIS"', () => {
    const chain = makeChain();
    const rec = chain.append(payload(1));
    const expected = sha256(`1:${rec.contentHash}:GENESIS`);
    expect(rec.chainHash).toBe(expected);
  });
});

// ── Deterministic hashing ─────────────────────────────────────────────────────

describe('deterministic hashing', () => {
  it('same input always produces same contentHash', () => {
    const a = makeChain();
    const b = makeChain();
    const data = payload(42);
    const recA = a.append(data);
    const recB = b.append(data);
    expect(recA.contentHash).toBe(recB.contentHash);
  });

  it('key insertion order does not affect contentHash', () => {
    const a = makeChain();
    const b = makeChain();

    // Same keys, different insertion order
    const dataA = { z: 'last', a: 'first', m: 'middle' };
    const dataB = { m: 'middle', z: 'last', a: 'first' };

    const recA = a.append(dataA);
    const recB = b.append(dataB);
    expect(recA.contentHash).toBe(recB.contentHash);
  });

  it('different inputs produce different contentHashes', () => {
    const chain = makeChain();
    const rec1 = chain.append(payload(1));
    const rec2 = chain.append(payload(2));
    expect(rec1.contentHash).not.toBe(rec2.contentHash);
  });

  it('chainHash differs even when contentHash is the same (due to sequenceNumber/previousHash)', () => {
    // Two separate chains with the exact same first payload
    const chainA = makeChain();
    const chainB = makeChain();
    const recA = chainA.append(payload(1));
    const recB = chainB.append(payload(1));

    // Content hashes should match
    expect(recA.contentHash).toBe(recB.contentHash);
    // Chain hashes should also match (same genesis + seq + content)
    expect(recA.chainHash).toBe(recB.chainHash);

    // Append a SECOND record; chain diverges
    const recA2 = chainA.append(payload(99));
    const recB2 = chainB.append(payload(100));
    expect(recA2.chainHash).not.toBe(recB2.chainHash);
  });
});

// ── Tamper detection ──────────────────────────────────────────────────────────

describe('verify() — tamper detection', () => {
  it('detects a corrupted chain_hash in the middle of the chain', () => {
    const chain = makeChain();
    for (let i = 1; i <= 5; i++) chain.append(payload(i));

    // Directly corrupt sequence_number = 3's chain_hash
    chain._db
      .prepare('UPDATE integrity_chain SET chain_hash = ? WHERE sequence_number = 3')
      .run('deadbeef'.repeat(8));

    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it('detects a corrupted content_hash', () => {
    const chain = makeChain();
    for (let i = 1; i <= 3; i++) chain.append(payload(i));

    chain._db
      .prepare('UPDATE integrity_chain SET content_hash = ? WHERE sequence_number = 2')
      .run('0'.repeat(64));

    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('detects a corrupted previous_hash linkage', () => {
    const chain = makeChain();
    for (let i = 1; i <= 4; i++) chain.append(payload(i));

    // Break the previous_hash on record 4 without updating its chain_hash —
    // the chain_hash will no longer match the stored fields
    chain._db
      .prepare('UPDATE integrity_chain SET previous_hash = ? WHERE sequence_number = 4')
      .run('fakehash'.repeat(8));

    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
  });

  it('detects corruption in the first record', () => {
    const chain = makeChain();
    chain.append(payload(1));

    chain._db
      .prepare('UPDATE integrity_chain SET chain_hash = ? WHERE sequence_number = 1')
      .run('00'.repeat(32));

    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('reports totalRecords correctly even when broken', () => {
    const chain = makeChain();
    for (let i = 1; i <= 5; i++) chain.append(payload(i));

    chain._db
      .prepare('UPDATE integrity_chain SET chain_hash = ? WHERE sequence_number = 5')
      .run('bad'.repeat(21) + 'b');

    const result = chain.verify();
    expect(result.totalRecords).toBe(5);
  });
});

// ── getRecord / getLatest ─────────────────────────────────────────────────────

describe('getRecord and getLatest', () => {
  it('getRecord returns null for non-existent sequence number', () => {
    const chain = makeChain();
    expect(chain.getRecord(99)).toBeNull();
  });

  it('getRecord returns the correct record', () => {
    const chain = makeChain();
    const appended = chain.append(payload(7));
    const fetched  = chain.getRecord(1);
    expect(fetched).not.toBeNull();
    expect(fetched!.contentHash).toBe(appended.contentHash);
    expect(fetched!.sequenceNumber).toBe(1);
  });

  it('getLatest returns null on an empty chain', () => {
    expect(makeChain().getLatest()).toBeNull();
  });

  it('getLatest returns the last appended record', () => {
    const chain = makeChain();
    chain.append(payload(1));
    chain.append(payload(2));
    const last = chain.append(payload(3));
    expect(chain.getLatest()!.sequenceNumber).toBe(3);
    expect(chain.getLatest()!.chainHash).toBe(last.chainHash);
  });

  it('getRecord returns all 5 records correctly', () => {
    const chain = makeChain();
    const appended: IntegrityRecord[] = [];
    for (let i = 1; i <= 5; i++) appended.push(chain.append(payload(i)));

    for (let seq = 1; seq <= 5; seq++) {
      const rec = chain.getRecord(seq);
      expect(rec).not.toBeNull();
      expect(rec!.contentHash).toBe(appended[seq - 1]!.contentHash);
    }
  });
});
