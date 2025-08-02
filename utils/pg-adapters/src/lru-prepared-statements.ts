/**
 * Reusable LRU prepared statement management for PostgreSQL adapters.
 *
 * This module provides a connection-aware prepared statement cache with LRU eviction
 * that can be used by any PostgreSQL adapter (postgres.js, PGLite, etc).
 */

import { LRU } from "@graphile/lru";
import crypto from "crypto";
import debugFactory from "debug";

const debug = debugFactory("@graphile/pg-adapters:lru-prepared");

export interface PreparedStatement {
  name: string;
  text: string;
  paramCount: number;
}

export interface ConnectionState {
  lru: LRU<string, PreparedStatement>;
  statements: Map<string, PreparedStatement>;
  counter: number;
}

export interface QueryResult {
  rows: any[];
  count?: number;
  rowCount?: number | null;
  affectedRows?: number | null;
  command?: string;
}

export interface QueryExecutor {
  (text: string, values?: any[]): Promise<QueryResult>;
}

export interface LRUPreparedStatementManager {
  /**
   * Execute a query with LRU-managed prepared statements.
   */
  executeQuery<TData>(
    clientKey: any, // Client identifier (sql instance, string, etc.)
    queryName: string | undefined,
    queryText: string,
    values: any[],
    executor: QueryExecutor,
    arrayMode?: boolean,
  ): Promise<{
    rows: readonly TData[];
    rowCount: number | null;
  }>;

  /**
   * Get statistics about the prepared statement cache.
   */
  getStats(): Map<
    any,
    {
      lruSize: number;
      maxSize: number;
      statements: string[];
    }
  >;

  /**
   * Clean up all prepared statements for a connection.
   */
  cleanupConnection(clientKey: any, executor: QueryExecutor): Promise<void>;

  /**
   * Clean up all prepared statements.
   */
  cleanupAll(executor: QueryExecutor): Promise<void>;

  /**
   * Release a connection (for connection pooling).
   */
  releaseConnection(clientKey: any): void;
}

// Track state per connection (by client key)
const connectionStates = new WeakMap<any, ConnectionState>();
// For string keys (like PGLite), we need a regular Map
const stringKeyStates = new Map<string, ConnectionState>();

// Generate a hash for query + param count
function generateStatementKey(text: string, paramCount: number): string {
  const hash = crypto
    .createHash("md5")
    .update(`${text}:${paramCount}`)
    .digest("hex");
  return hash.substring(0, 16);
}

// Format a value for EXECUTE statement
function formatValue(value: any): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) {
    return `ARRAY[${value.map((item) => formatValue(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    // Handle JSON
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  return String(value);
}

// Get or create connection state
function getConnectionState(
  clientKey: any,
  maxPreparedStatements: number,
): ConnectionState {
  // Use WeakMap for objects, Map for strings
  const isString = typeof clientKey === "string";
  const storage = isString ? stringKeyStates : connectionStates;

  let state = storage.get(clientKey);
  if (!state) {
    state = {
      lru: new LRU({ maxLength: maxPreparedStatements }),
      statements: new Map(),
      counter: 0,
    };
    storage.set(clientKey, state);
    debug(
      `Initialized state for client key ${isString ? clientKey : "[object]"}`,
    );
  }
  return state;
}

// Clean up state for old string-based connections periodically
function cleanupStringStates() {
  // Limit the number of string-based connections we track
  if (stringKeyStates.size > 100) {
    const oldestKey = stringKeyStates.keys().next().value;
    if (oldestKey !== undefined) {
      stringKeyStates.delete(oldestKey);
      debug(`Cleaned up state for old string key ${oldestKey}`);
    }
  }
}

/**
 * Create an LRU prepared statement manager.
 */
export function createLRUPreparedStatementManager(
  maxPreparedStatements: number = 100,
  statementPrefix: string = "lru",
): LRUPreparedStatementManager {
  // Generate a unique ID for this manager instance
  const managerId = Math.random().toString(36).slice(2, 8);

  return {
    async executeQuery<TData>(
      clientKey: any,
      queryName: string | undefined,
      queryText: string,
      values: any[],
      executor: QueryExecutor,
      arrayMode?: boolean,
    ): Promise<{ rows: readonly TData[]; rowCount: number | null }> {
      // For queries without parameters or name, execute directly
      if (!queryName || values.length === 0) {
        const result = await executor(queryText, values);
        return {
          rows: (arrayMode
            ? result.rows.map((row: any) => Object.values(row))
            : result.rows) as readonly TData[],
          rowCount:
            result.count ?? result.rowCount ?? result.affectedRows ?? null,
        };
      }

      // Get connection state
      const state = getConnectionState(clientKey, maxPreparedStatements);

      // Generate key for this query
      const key = generateStatementKey(queryText, values.length);

      // Check if we have this prepared statement
      let stmt = state.statements.get(key);

      if (!stmt) {
        // Create new prepared statement
        const stmtName = `${statementPrefix}_${managerId}_${state.counter++}`;

        debug(`Creating prepared statement ${stmtName} for query ${queryName}`);

        try {
          // Prepare the statement
          await executor(`PREPARE ${stmtName} AS ${queryText}`);

          stmt = { name: stmtName, text: queryText, paramCount: values.length };
          state.statements.set(key, stmt);

          // Update LRU
          state.lru.set(key, stmt);

          // Check if we need to evict
          if (state.statements.size > maxPreparedStatements) {
            // Find the least recently used key that's not in the LRU
            for (const [k, v] of state.statements) {
              if (!state.lru.get(k)) {
                debug(`Evicting prepared statement ${v.name}`);
                try {
                  await executor(`DEALLOCATE ${v.name}`);
                } catch (err) {
                  debug(`Failed to deallocate ${v.name}: ${err}`);
                }
                state.statements.delete(k);
                break;
              }
            }
          }
        } catch (err) {
          debug(`Failed to prepare statement: ${err}`);
          // Fall back to direct execution
          const result = await executor(queryText, values);
          return {
            rows: (arrayMode
              ? result.rows.map((row: any) => Object.values(row))
              : result.rows) as readonly TData[],
            rowCount:
              result.count ?? result.rowCount ?? result.affectedRows ?? null,
          };
        }
      } else {
        // Update LRU
        state.lru.get(key);
      }

      // Execute prepared statement
      try {
        const executeQuery =
          values.length > 0
            ? `EXECUTE ${stmt.name}(${values.map((v) => formatValue(v)).join(", ")})`
            : `EXECUTE ${stmt.name}`;

        const result = await executor(executeQuery);

        return {
          rows: (arrayMode
            ? result.rows.map((row: any) => Object.values(row))
            : result.rows) as readonly TData[],
          rowCount:
            result.count ?? result.rowCount ?? result.affectedRows ?? null,
        };
      } catch (err: any) {
        if (err.message?.includes("does not exist")) {
          // Statement was deallocated, remove and retry
          debug(`Statement ${stmt.name} missing, retrying`);
          state.statements.delete(key);
          return this.executeQuery(
            clientKey,
            queryName,
            queryText,
            values,
            executor,
            arrayMode,
          );
        }
        throw err;
      } finally {
        // Periodic cleanup for string-based states
        if (typeof clientKey === "string" && Math.random() < 0.01) {
          cleanupStringStates();
        }
      }
    },

    getStats() {
      const stats = new Map<any, any>();

      // Add object-based states (from WeakMap - we can't iterate it)
      // This is a limitation, but acceptable since WeakMap is for GC

      // Add string-based states
      for (const [key, state] of stringKeyStates) {
        stats.set(key, {
          lruSize: state.lru.length,
          maxSize: maxPreparedStatements,
          statements: Array.from(state.statements.keys()),
        });
      }

      return stats;
    },

    async cleanupConnection(clientKey: any, executor: QueryExecutor) {
      const isString = typeof clientKey === "string";
      const storage = isString ? stringKeyStates : connectionStates;
      const state = storage.get(clientKey);

      if (state) {
        for (const stmt of state.statements.values()) {
          try {
            await executor(`DEALLOCATE ${stmt.name}`);
          } catch (err) {
            debug(`Failed to deallocate ${stmt.name} during cleanup: ${err}`);
          }
        }
        storage.delete(clientKey);
      }
    },

    async cleanupAll(executor: QueryExecutor) {
      // Clean up string-based states
      for (const [, state] of stringKeyStates) {
        for (const stmt of state.statements.values()) {
          try {
            await executor(`DEALLOCATE ${stmt.name}`);
          } catch (err) {
            debug(`Failed to deallocate ${stmt.name} during cleanup: ${err}`);
          }
        }
      }
      stringKeyStates.clear();

      // Note: We can't iterate WeakMap, so object-based states will be GC'd
    },

    releaseConnection(clientKey: any) {
      // This is called when a connection is released back to the pool
      // We don't need to clean up statements, just mark it as available
      debug(
        `Connection released for client key ${typeof clientKey === "string" ? clientKey : "[object]"}`,
      );
    },
  };
}
