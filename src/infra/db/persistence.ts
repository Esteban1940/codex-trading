import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

export interface Persistence {
  insertEvent(type: string, payload: unknown): Promise<void>;
  getState<T>(key: string): Promise<T | undefined>;
  putState<T>(key: string, value: T): Promise<void>;
}

interface StoredStateRecord<T = unknown> {
  updatedAt: number;
  value: T;
}

type StoredStateMap = Record<string, StoredStateRecord>;

class FilePersistence implements Persistence {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventsPath: string,
    private readonly statePath: string
  ) {}

  /**
   * Appends immutable event records into a local JSONL ledger.
   */
  async insertEvent(type: string, payload: unknown): Promise<void> {
    const record = {
      ts: Date.now(),
      type,
      payload
    };
    await this.enqueueWrite(async () => {
      await this.ensureParentDir(this.eventsPath);
      await fs.appendFile(this.eventsPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  }

  /**
   * Reads a state key from the local state snapshot file.
   */
  async getState<T>(key: string): Promise<T | undefined> {
    const map = await this.readStateMap();
    const record = map[key];
    return (record?.value as T | undefined) ?? undefined;
  }

  /**
   * Upserts a state key atomically (temp file + rename).
   */
  async putState<T>(key: string, value: T): Promise<void> {
    await this.enqueueWrite(async () => {
      const current = await this.readStateMap();
      current[key] = {
        updatedAt: Date.now(),
        value
      };
      await this.ensureParentDir(this.statePath);
      const tempPath = `${this.statePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(current, null, 2), "utf8");
      await fs.rename(tempPath, this.statePath);
    });
  }

  /**
   * Loads the current state map from disk; returns empty map on missing/corrupt file.
   */
  private async readStateMap(): Promise<StoredStateMap> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as StoredStateMap;
    } catch (error) {
      const maybe = error as NodeJS.ErrnoException;
      if (maybe?.code === "ENOENT") return {};
      return {};
    }
  }

  /**
   * Ensures parent directory exists before writing event/state files.
   */
  private async ensureParentDir(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  /**
   * Serializes writes to avoid race conditions between concurrent cycles.
   */
  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}

export class SqlitePersistence implements Persistence {
  private readonly delegate: FilePersistence;

  constructor(sqlitePath = "./data/trading.db") {
    const parsed = path.parse(path.resolve(sqlitePath));
    const stem = path.join(parsed.dir, parsed.name || "trading");
    this.delegate = new FilePersistence(`${stem}.events.jsonl`, `${stem}.state.json`);
  }

  /**
   * Delegates event append to file-backed sqlite-compatible storage.
   */
  insertEvent(type: string, payload: unknown): Promise<void> {
    return this.delegate.insertEvent(type, payload);
  }

  /**
   * Delegates state read to file-backed sqlite-compatible storage.
   */
  getState<T>(key: string): Promise<T | undefined> {
    return this.delegate.getState<T>(key);
  }

  /**
   * Delegates state write to file-backed sqlite-compatible storage.
   */
  putState<T>(key: string, value: T): Promise<void> {
    return this.delegate.putState(key, value);
  }
}

export class PostgresPersistence implements Persistence {
  private readonly pool: Pool;
  private initPromise?: Promise<void>;

  constructor(postgresUrl = "postgresql://trader:trader@localhost:5432/trading") {
    const hash = createHash("sha1").update(postgresUrl).digest("hex").slice(0, 12);
    const appName = `codex-trading-${hash}`;
    this.pool = new Pool({
      connectionString: postgresUrl,
      application_name: appName
    });
  }

  /**
   * Inserts raw event payload in PostgreSQL JSONB for audit/analytics.
   */
  async insertEvent(type: string, payload: unknown): Promise<void> {
    await this.ensureInit();
    await this.pool.query("INSERT INTO events(ts, type, payload) VALUES($1, $2, $3::jsonb)", [
      Date.now(),
      type,
      JSON.stringify(payload ?? null)
    ]);
  }

  /**
   * Reads one state key from PostgreSQL state table.
   */
  async getState<T>(key: string): Promise<T | undefined> {
    await this.ensureInit();
    const result = await this.pool.query<{ value: T }>(
      "SELECT value FROM state_kv WHERE key = $1 LIMIT 1",
      [key]
    );
    return result.rows[0]?.value;
  }

  /**
   * Upserts state key in PostgreSQL.
   */
  async putState<T>(key: string, value: T): Promise<void> {
    await this.ensureInit();
    await this.pool.query(
      [
        "INSERT INTO state_kv(key, value, updated_at)",
        "VALUES($1, $2::jsonb, $3)",
        "ON CONFLICT (key) DO UPDATE",
        "SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"
      ].join(" "),
      [key, JSON.stringify(value ?? null), Date.now()]
    );
  }

  /**
   * Creates required tables/indexes on first use.
   */
  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.pool.query(
          "CREATE TABLE IF NOT EXISTS events(id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL)"
        );
        await this.pool.query(
          "CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts DESC)"
        );
        await this.pool.query(
          "CREATE TABLE IF NOT EXISTS state_kv(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at BIGINT NOT NULL)"
        );
      })();
    }
    await this.initPromise;
  }
}

export class NoopPersistence implements Persistence {
  /**
   * No-op implementation for dry runs or tests.
   */
  async insertEvent(type: string, payload: unknown): Promise<void> {
    void type;
    void payload;
  }

  /**
   * Always returns undefined (no persisted state).
   */
  async getState<T>(key: string): Promise<T | undefined> {
    void key;
    return undefined;
  }

  /**
   * No-op state write.
   */
  async putState<T>(key: string, value: T): Promise<void> {
    void key;
    void value;
  }
}
