export interface Persistence {
  insertEvent(type: string, payload: unknown): Promise<void>;
}

export class SqlitePersistence implements Persistence {
  async insertEvent(type: string, payload: unknown): Promise<void> {
    void type;
    void payload;
  }
}

export class PostgresPersistence implements Persistence {
  async insertEvent(type: string, payload: unknown): Promise<void> {
    void type;
    void payload;
  }
}
