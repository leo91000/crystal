/**
 * PostgreSQL adapter for the '@electric-sql/pglite' module with LRU prepared statement management.
 * PGlite is a WASM Postgres build that runs in Node.js, Bun, and the browser.
 */

import debugFactory from "debug";
import type { PGlite } from "@electric-sql/pglite";

export type { PGlite } from "@electric-sql/pglite";

import type {
  ListenError,
  PgAdapterFactory,
  PgClient,
  PgClientQuery,
  PgClientResult,
} from "../interfaces.js";
import {
  createLRUPreparedStatementManager,
  type QueryExecutor,
} from "../lru-prepared-statements.js";

const debug = debugFactory("@graphile/pg-adapters:pglite");

// Dynamic import to avoid requiring '@electric-sql/pglite' when not used
let pgliteModule: typeof import("@electric-sql/pglite") | null = null;

async function getPGliteModule() {
  if (!pgliteModule) {
    try {
      pgliteModule = await import("@electric-sql/pglite");
    } catch (error) {
      throw new Error(
        "The '@electric-sql/pglite' module is required to use the PGlite adapter. " +
        "Please install it with: npm install @electric-sql/pglite",
      );
    }
  }
  return pgliteModule;
}

export interface PGlitePgClient extends PgClient {
  pglite: PGlite;
}

export interface PGliteAdapterConfig {
  /** Direct PGlite instance (alternative to dataDir) */
  pglite?: PGlite;
  /**
   * Data directory for PGlite database files, or ":memory:" for in-memory database.
   * If not provided, defaults to ":memory:".
   */
  dataDir?: string;
  /**
   * Data source for PGlite. Can be a file path, ":memory:", or IndexedDB URL.
   * This is an alias for dataDir for compatibility.
   */
  dataSource?: string;
  /** PGlite extensions to load */
  extensions?: Record<string, any>;
  /** Maximum number of prepared statements (default: 100) */
  maxPreparedStatements?: number;
  /** Additional options to pass to PGlite constructor */
  pgliteOptions?: Record<string, any>;
  /** Enable debug logging */
  debug?: boolean;
}


function createPGlitePgClient(
  pglite: PGlite,
  lruManager: ReturnType<typeof createLRUPreparedStatementManager>,
  txLevel: number = 0,
  alreadyInTransaction: boolean = false,
): PGlitePgClient {
  // Create executor function for this PGlite instance
  const executor: QueryExecutor = async (text: string, values?: any[]) => {
    const result = await pglite.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? null,
      affectedRows: result.affectedRows,
    };
  };

  return {
    pglite,
    async query<TData>(opts: PgClientQuery): Promise<PgClientResult<TData>> {
      const { text, values = [], name, arrayMode } = opts;

      try {
        return await lruManager.executeQuery<TData>(
          "pglite-static", // Static key for PGLite (single connection)
          name,
          text,
          values,
          executor,
          arrayMode,
        );
      } catch (error) {
        debug("Query error:", error);
        throw error;
      }
    },

    async withTransaction<T>(
      callback: (client: PGlitePgClient) => Promise<T>,
    ): Promise<T> {
      // For level 0, use PGLite's native transaction method (has internal mutex)
      if (txLevel === 0 && !alreadyInTransaction) {
        return pglite.transaction(async (tx) => {
          // Create a new client that uses the transaction
          const txClient = createPGlitePgClient(
            pglite,
            lruManager,
            1, // Now at level 1
            false, // Not already in transaction
          );

          // Override the query method to use the transaction's query
          txClient.query = async <TData>(
            opts: PgClientQuery,
          ): Promise<PgClientResult<TData>> => {
            const { text, values = [], name, arrayMode } = opts;

            // For non-prepared statements, use the transaction's query directly
            if (!name) {
              const result = await tx.query(text, values, {
                rowMode: arrayMode ? "array" : "object",
              });
              return {
                rows: result.rows as readonly TData[],
                rowCount: result.affectedRows ?? null,
              };
            }

            // For prepared statements, use our LRU manager with tx executor
            const txExecutor: QueryExecutor = async (
              text: string,
              values?: any[],
            ) => {
              const result = await tx.query(text, values);
              return {
                rows: result.rows,
                rowCount: result.affectedRows ?? null,
                affectedRows: result.affectedRows,
              };
            };

            return await lruManager.executeQuery<TData>(
              "pglite-static", // Same static key
              name,
              text,
              values,
              txExecutor,
              arrayMode,
            );
          };

          return await callback(txClient);
        });
      } else {
        // For nested transactions, use savepoints
        await pglite.exec(`SAVEPOINT tx${txLevel === 0 ? "" : txLevel}`);

        try {
          const newClient = createPGlitePgClient(
            pglite,
            lruManager,
            txLevel + 1,
            alreadyInTransaction,
          );
          const result = await callback(newClient);

          await pglite.exec(
            `RELEASE SAVEPOINT tx${txLevel === 0 ? "" : txLevel}`,
          );

          return result;
        } catch (error) {
          try {
            await pglite.exec(
              `ROLLBACK TO SAVEPOINT tx${txLevel === 0 ? "" : txLevel}`,
            );
          } catch (rollbackError) {
            debug("Error during rollback:", rollbackError);
          }
          throw error;
        }
      }
    },
  };
}

async function createPGliteInstance(
  config: PGliteAdapterConfig,
): Promise<PGlite> {
  const pgliteModule = await getPGliteModule();
  const { PGlite } = pgliteModule;

  if (config.pglite) {
    return config.pglite;
  }

  // Determine the data source
  const dataSource = config.dataDir ?? ":memory:";
  const options = {
    ...config.pgliteOptions,
  };

  return new PGlite(dataSource, options);
}


/**
 * Creates a PostgreSQL adapter using the '@electric-sql/pglite' module with LRU prepared statement management.
 *
 * Note: PGlite is single-threaded and doesn't support connection pooling
 * in the traditional sense. Each adapter instance uses a single PGlite instance.
 */
export const createPGLiteAdapter: PgAdapterFactory<
  PGliteAdapterConfig,
  PGlitePgClient
> = (config: PGliteAdapterConfig) => {
  const maxPreparedStatements = config.maxPreparedStatements || 100;
  const lruManager = createLRUPreparedStatementManager(
    maxPreparedStatements,
    "pglite",
  );

  let pglite: PGlite | null = null;
  let pglitePromise: Promise<PGlite> | null = null;

  const getPGlite = async (): Promise<PGlite> => {
    if (pglite) return pglite;
    if (pglitePromise) return pglitePromise;

    pglitePromise = createPGliteInstance(config);
    pglite = await pglitePromise;
    pglitePromise = null;
    return pglite;
  };

  return {
    async withPgClient(pgSettings, callback) {
      const pgliteInstance = await getPGlite();

      // Apply pgSettings if provided
      if (pgSettings && Object.keys(pgSettings).length > 0) {
        // Use runExclusive to ensure exclusive access and proper mutex handling
        // No need for our own queue since runExclusive handles that
        return await pgliteInstance.runExclusive(async () => {
          // Store original settings to restore later
          const originalSettings: Array<[string, string | null]> = [];

          // Get current settings values
          for (const key of Object.keys(pgSettings)) {
            if (pgSettings[key] != null) {
              const result = await pgliteInstance.query<{
                value: string | null;
              }>("SELECT current_setting($1, true) as value", [key]);
              originalSettings.push([key, result.rows[0]?.value ?? null]);
            }
          }

          try {
            // Set session variables using a single query
            const pgSettingsEntries: Array<[string, string]> = [];
            for (const [key, value] of Object.entries(pgSettings)) {
              if (value != null) {
                pgSettingsEntries.push([key, String(value)]);
              }
            }

            if (pgSettingsEntries.length > 0) {
              await pgliteInstance.query(
                "SELECT set_config(el->>0, el->>1, false) FROM json_array_elements($1::json) el",
                [JSON.stringify(pgSettingsEntries)],
              );
            }

            const client = createPGlitePgClient(
              pgliteInstance,
              lruManager,
              0, // txLevel = 0, not in a transaction
              false, // alreadyInTransaction = false
            );

            return await callback(client);
          } finally {
            // Restore original settings
            if (originalSettings.length > 0) {
              const restoreEntries = originalSettings
                .filter(([_, value]) => value !== null)
                .map(([key, value]) => [key, value as string]);

              if (restoreEntries.length > 0) {
                await pgliteInstance.query(
                  "SELECT set_config(el->>0, el->>1, false) FROM json_array_elements($1::json) el",
                  [JSON.stringify(restoreEntries)],
                );
              }

              // Reset any settings that were originally null
              for (const [key, value] of originalSettings) {
                if (value === null && pgSettings[key] != null) {
                  // RESET doesn't support parameters, need to escape the key
                  const escapedKey = key.replace(/"/g, '""');
                  await pgliteInstance.exec(`RESET "${escapedKey}"`);
                }
              }
            }
          }
        });
      } else {
        const client = createPGlitePgClient(
          pgliteInstance,
          lruManager,
          0,
          false,
        );
        return await callback(client);
      }
    },

    async listen(
      channel: string,
      onnotify: (payload: string | null) => void,
      onError?: (error: ListenError) => void,
    ): Promise<{ unlisten: () => Promise<void> }> {
      const pgliteInstance = await getPGlite();
      let unsubscribe: (() => void) | null = null;

      try {
        // PGLite supports LISTEN/NOTIFY natively
        unsubscribe = await pgliteInstance.listen(
          channel,
          (payload: string) => {
            onnotify(payload || null);
          },
        );

        debug(`Listening on channel "${channel}"`);

        // Return unlisten function
        return {
          unlisten: async () => {
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }
          },
        };
      } catch (err: any) {
        const listenError: ListenError = Object.assign(
          new Error(`Failed to LISTEN on channel "${channel}": ${err.message}`),
          {
            channel,
            originalError: err,
          },
        );

        if (onError) {
          onError(listenError);
        }

        throw listenError;
      }
    },

    getPoolSize() {
      // PGLite is single-connection, always return 1
      return 1;
    },

    async release() {
      if (pglite) {
        // Clean up all prepared statements before closing
        const executor: QueryExecutor = async (
          text: string,
          values?: any[],
        ) => {
          const result = await pglite!.query(text, values);
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? null,
            affectedRows: result.affectedRows,
          };
        };
        await lruManager.cleanupConnection("pglite-static", executor);

        if (!config.pglite) {
          // Only close the instance if we created it
          await pglite.close();
          pglite = null;
        }
      }
    },
  };
};
