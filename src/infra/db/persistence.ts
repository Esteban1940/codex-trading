import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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

  async getState<T>(key: string): Promise<T | undefined> {
    const map = await this.readStateMap();
    const record = map[key];
    return (record?.value as T | undefined) ?? undefined;
  }

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

  private async ensureParentDir(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

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

  insertEvent(type: string, payload: unknown): Promise<void> {
    return this.delegate.insertEvent(type, payload);
  }

  getState<T>(key: string): Promise<T | undefined> {
    return this.delegate.getState<T>(key);
  }

  putState<T>(key: string, value: T): Promise<void> {
    return this.delegate.putState(key, value);
  }
}

export class PostgresPersistence implements Persistence {
  private readonly delegate: FilePersistence;

  constructor(postgresUrl = "postgresql://trader:trader@localhost:5432/trading") {
    const hash = createHash("sha1").update(postgresUrl).digest("hex").slice(0, 12);
    const stem = path.resolve("./data", `postgres-${hash}`);
    this.delegate = new FilePersistence(`${stem}.events.jsonl`, `${stem}.state.json`);
  }

  insertEvent(type: string, payload: unknown): Promise<void> {
    return this.delegate.insertEvent(type, payload);
  }

  getState<T>(key: string): Promise<T | undefined> {
    return this.delegate.getState<T>(key);
  }

  putState<T>(key: string, value: T): Promise<void> {
    return this.delegate.putState(key, value);
  }
}

export class NoopPersistence implements Persistence {
  async insertEvent(type: string, payload: unknown): Promise<void> {
    void type;
    void payload;
  }

  async getState<T>(key: string): Promise<T | undefined> {
    void key;
    return undefined;
  }

  async putState<T>(key: string, value: T): Promise<void> {
    void key;
    void value;
  }
}
