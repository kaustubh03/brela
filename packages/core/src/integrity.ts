import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface IntegrityRecord {
  sequenceNumber: number;
  /** SHA-256 hex of the deterministically serialised attribution data. */
  contentHash:    string;
  /** chain_hash of the previous record, or "GENESIS" for the first record. */
  previousHash:   string;
  /** SHA-256 hex of (sequenceNumber + contentHash + previousHash). */
  chainHash:      string;
  timestamp:      number;
  /** Reserved for future key-based signing; always null for now. */
  signature:      string | null;
}

// ── Internal DB row shape ──────────────────────────────────────────────────────

interface DbRow {
  sequence_number: number;
  content_hash:    string;
  previous_hash:   string;
  chain_hash:      string;
  timestamp:       number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const GENESIS = 'GENESIS';

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so
 * the same logical object always produces the same byte string.
 */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + (value as unknown[]).map(sortedJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${sortedJson(obj[k])}`).join(',') + '}';
}

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function rowToRecord(row: DbRow): IntegrityRecord {
  return {
    sequenceNumber: row.sequence_number,
    contentHash:    row.content_hash,
    previousHash:   row.previous_hash,
    chainHash:      row.chain_hash,
    timestamp:      row.timestamp,
    signature:      null,
  };
}

// ── IntegrityChain ─────────────────────────────────────────────────────────────

/**
 * Hash chain stored in an `integrity_chain` table inside a SQLite database.
 * Each record's `chainHash` commits to the record content AND to the entire
 * preceding chain, making any retroactive tamper detectable by `verify()`.
 *
 * The `_db` property is intentionally accessible so tests can directly
 * manipulate rows to exercise corruption detection.
 */
export class IntegrityChain {
  /** The underlying better-sqlite3 connection (exposed for tests). */
  readonly _db: Database.Database;

  private readonly _insert:  Database.Statement;
  private readonly _latest:  Database.Statement;
  private readonly _bySeq:   Database.Statement;
  private readonly _allAsc:  Database.Statement;

  constructor(dbPath = '.brela/integrity.db') {
    this._db = new Database(dbPath);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS integrity_chain (
        sequence_number INTEGER PRIMARY KEY,
        content_hash    TEXT    NOT NULL,
        previous_hash   TEXT    NOT NULL,
        chain_hash      TEXT    NOT NULL,
        timestamp       INTEGER NOT NULL
      )
    `);

    this._insert = this._db.prepare(`
      INSERT INTO integrity_chain
        (sequence_number, content_hash, previous_hash, chain_hash, timestamp)
      VALUES
        (@sequenceNumber, @contentHash, @previousHash, @chainHash, @timestamp)
    `);

    this._latest = this._db.prepare(
      'SELECT * FROM integrity_chain ORDER BY sequence_number DESC LIMIT 1',
    );

    this._bySeq = this._db.prepare(
      'SELECT * FROM integrity_chain WHERE sequence_number = ?',
    );

    this._allAsc = this._db.prepare(
      'SELECT * FROM integrity_chain ORDER BY sequence_number ASC',
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Append a new attribution record to the chain.
   *
   * Attribution data is serialised with sorted keys to ensure the same
   * logical payload always produces the same `contentHash`.
   */
  append(attributionData: Record<string, unknown>): IntegrityRecord {
    const serialised  = sortedJson(attributionData);
    const contentHash = sha256(serialised);

    const prevRow    = this._latest.get() as DbRow | undefined;
    const prev       = prevRow ? rowToRecord(prevRow) : null;

    const previousHash   = prev ? prev.chainHash : GENESIS;
    const sequenceNumber = prev ? prev.sequenceNumber + 1 : 1;

    const chainHash = sha256(`${sequenceNumber}:${contentHash}:${previousHash}`);
    const timestamp = Date.now();

    this._insert.run({ sequenceNumber, contentHash, previousHash, chainHash, timestamp });

    return { sequenceNumber, contentHash, previousHash, chainHash, timestamp, signature: null };
  }

  /**
   * Walk the full chain and verify every `chainHash` is internally consistent
   * and that each record's `previousHash` matches the preceding record's
   * `chainHash`.
   *
   * @returns `{ valid, brokenAt, totalRecords }`
   */
  verify(): { valid: boolean; brokenAt: number | null; totalRecords: number } {
    const rows = this._allAsc.all() as DbRow[];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;

      // Re-derive the expected chain_hash from stored fields
      const expected = sha256(`${row.sequence_number}:${row.content_hash}:${row.previous_hash}`);
      if (row.chain_hash !== expected) {
        return { valid: false, brokenAt: row.sequence_number, totalRecords: rows.length };
      }

      // Verify the linkage to the previous record
      if (i === 0) {
        if (row.previous_hash !== GENESIS) {
          return { valid: false, brokenAt: row.sequence_number, totalRecords: rows.length };
        }
      } else {
        if (row.previous_hash !== rows[i - 1]!.chain_hash) {
          return { valid: false, brokenAt: row.sequence_number, totalRecords: rows.length };
        }
      }
    }

    return { valid: true, brokenAt: null, totalRecords: rows.length };
  }

  /**
   * Retrieve a single record by sequence number.
   * Returns `null` if the sequence number does not exist.
   */
  getRecord(sequenceNumber: number): IntegrityRecord | null {
    const row = this._bySeq.get(sequenceNumber) as DbRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Return the most recently appended record, or `null` if the chain is empty.
   */
  getLatest(): IntegrityRecord | null {
    const row = this._latest.get() as DbRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}
