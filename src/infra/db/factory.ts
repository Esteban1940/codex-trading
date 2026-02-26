import type { AppConfig } from "../config.js";
import type { Persistence } from "./persistence.js";
import { NoopPersistence, PostgresPersistence, SqlitePersistence } from "./persistence.js";

export function createPersistence(cfg: AppConfig): Persistence {
  if (cfg.PERSISTENCE_BACKEND === "postgres") {
    return new PostgresPersistence(cfg.POSTGRES_URL);
  }
  if (cfg.PERSISTENCE_BACKEND === "none") {
    return new NoopPersistence();
  }
  return new SqlitePersistence(cfg.SQLITE_PATH);
}
