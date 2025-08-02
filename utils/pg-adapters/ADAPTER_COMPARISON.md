# PostgreSQL Adapter Comparison

This document outlines the key differences and similarities between the three
PostgreSQL adapters.

## Overview

| Feature                 | node-postgres (pg)            | postgres.js                   | PGLite                        |
| ----------------------- | ----------------------------- | ----------------------------- | ----------------------------- |
| **Module**              | `pg`                          | `postgres`                    | `@electric-sql/pglite`        |
| **Connection Type**     | Traditional TCP/IP            | Traditional TCP/IP            | In-process WASM               |
| **Connection Pooling**  | Built-in Pool class           | Built-in connection pool      | Single connection only        |
| **Prepared Statements** | LRU with configurable size    | LRU with configurable size    | LRU with configurable size    |
| **Transaction Support** | Full (BEGIN/COMMIT/SAVEPOINT) | Full (BEGIN/COMMIT/SAVEPOINT) | Full (BEGIN/COMMIT/SAVEPOINT) |

## Key Differences

### 1. Connection Management

**node-postgres:**

- Uses `Pool` and `PoolClient` for connection pooling
- Supports multiple concurrent connections
- Clients must be explicitly released back to the pool
- Has `alwaysQueue` parameter for forcing serial execution

**postgres.js:**

- Built-in connection pooling via the `Sql` instance
- Connections are managed automatically
- No explicit release needed for individual queries
- Simpler API with automatic connection management

**PGLite:**

- **No connection pooling** - single connection only
- Runs in-process as WASM, not over network
- Supports in-memory (`:memory:`) or file-based storage
- Ideal for testing, embedded scenarios, or browser usage

### 2. Transaction Handling

**node-postgres:**

- Manual transaction management with explicit BEGIN/COMMIT/ROLLBACK
- Uses savepoints for nested transactions
- Tracks transaction level with `txLevel` parameter

**postgres.js:**

- Uses `sql.begin()` helper for transactions
- Automatic transaction management with callback pattern
- Cleaner API: `await sql.begin(async (tx) => { ... })`

**PGLite:**

- Uses native `pglite.transaction()` for top-level transactions (has internal
  mutex)
- Falls back to manual savepoints for nested transactions
- Special handling needed because PGLite's transaction method provides better
  isolation

### 3. Queue Mechanism

**node-postgres:**

- Uses `$$queue` symbol on the client object
- Has `alwaysQueue` parameter to force queuing even without pgSettings
- Queue ensures serial execution of operations on same client

**postgres.js:**

- Uses `$$queue` symbol on the Sql instance
- Only queues when pgSettings are provided
- Prevents concurrent transactions with different settings

**PGLite:**

- Uses `$$queue` symbol on the PGLite instance
- Only queues when pgSettings are provided
- Ensures settings isolation in single-connection environment

### 4. Prepared Statement Management

All three adapters now use the same LRU-based prepared statement management:

- Configurable cache size (default: 100)
- Automatic eviction of least recently used statements
- Uses client-specific keys to track statements
- Handles both named and unnamed statements

### 5. Settings Application

All adapters use the same efficient query for applying settings:

```sql
SELECT set_config(el->>0, el->>1, true)
FROM json_array_elements($1::json) el
```

### 6. Error Handling

**node-postgres:**

- Standard PostgreSQL error objects
- Explicit transaction rollback required

**postgres.js:**

- Enhanced error objects with additional context
- Automatic rollback on error in transaction blocks

**PGLite:**

- PostgreSQL-compatible errors
- Manual rollback handling required
- Additional error handling for WASM-specific issues

## Usage Recommendations

### Use node-postgres when:

- You need fine-grained control over connections
- Working with existing node-postgres code
- Need specific pool configuration options
- Require explicit connection management

### Use postgres.js when:

- You want a simpler, more modern API
- Prefer automatic connection management
- Like the tagged template literal query syntax
- Want better TypeScript support out of the box

### Use PGLite when:

- Running tests that need isolated databases
- Building browser-based applications
- Need an embedded database
- Want zero-latency database access
- Don't need concurrent connections

## Configuration Examples

### node-postgres

```typescript
{
  connectionString: "postgres://localhost/mydb",
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
  maxPreparedStatements: 100
}
```

### postgres.js

```typescript
{
  connectionString: "postgres://localhost/mydb",
  maxConnections: 20,
  maxPreparedStatements: 100
}
```

### PGLite

```typescript
{
  dataDir: ":memory:", // or "./pgdata"
  extensions: {
    vector: vectorExtension(),
  },
  maxPreparedStatements: 100
}
```

## Performance Considerations

1. **Network Overhead**: PGLite has zero network overhead since it runs
   in-process
2. **Connection Pooling**: postgres.js and node-postgres can handle more
   concurrent requests
3. **Prepared Statements**: All adapters now have equal performance with LRU
   caching
4. **Memory Usage**: PGLite uses more memory as it runs the entire database
   in-process

## Migration Notes

- All adapters implement the same `PgAdapter` interface
- Query results are normalized to the same format
- Prepared statement behavior is now consistent across all adapters
- The main differences are in connection management and configuration
