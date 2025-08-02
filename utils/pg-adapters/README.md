# @graphile/pg-adapters

PostgreSQL adapters for Graphile projects, providing a unified interface for
different PostgreSQL drivers.

## Overview

This package provides database-agnostic PostgreSQL adapters that can be used
across different Graphile projects like PostGraphile and graphile-worker. It
supports multiple PostgreSQL drivers through a common interface.

## Supported Adapters

- **node-postgres** (`pg`) - The most popular PostgreSQL driver for Node.js
- **postgres.js** - A modern PostgreSQL driver with excellent TypeScript support
- **PGlite** - A WASM Postgres build that runs in Node.js, Bun, and browsers

## Installation

```bash
# Install the adapters package
npm install @graphile/pg-adapters

# Install the specific database driver you want to use
npm install pg @types/pg              # For node-postgres
npm install postgres                  # For postgres.js
npm install @electric-sql/pglite      # For PGlite
```

## Usage

### Node.js (pg) Adapter

```typescript
import { createNodePostgresAdapter } from "@graphile/pg-adapters/node-postgres";

const withPgClient = createNodePostgresAdapter({
  connectionString: "postgresql://user:pass@localhost/db",
  maxConnections: 10,
});

// Use the client
await withPgClient(null, async (client) => {
  const result = await client.query({
    text: "SELECT * FROM users WHERE id = $1",
    values: [123],
  });
  console.log(result.rows);
});

// Clean up when done
await withPgClient.release();
```

### Postgres.js Adapter

```typescript
import { createPostgresJsAdapter } from "@graphile/pg-adapters/postgres";

const withPgClient = createPostgresJsAdapter({
  connectionString: "postgresql://user:pass@localhost/db",
  maxConnections: 10,
});

await withPgClient(null, async (client) => {
  const result = await client.query({
    text: "SELECT * FROM users WHERE id = $1",
    values: [123],
  });
  console.log(result.rows);
});
```

### PGlite Adapter

```typescript
import { createPGliteAdapter } from "@graphile/pg-adapters/pglite";

const withPgClient = createPGliteAdapter({
  dataDir: "./my-database", // or ":memory:" for in-memory (default)
});

await withPgClient(null, async (client) => {
  const result = await client.query({
    text: "SELECT * FROM users WHERE id = $1",
    values: [123],
  });
  console.log(result.rows);
});
```

## Advanced Usage

### With PostgreSQL Settings

```typescript
await withPgClient(
  {
    search_path: "public,extensions",
    timezone: "UTC",
  },
  async (client) => {
    // Settings are applied for this callback
    const result = await client.query({
      text: "SELECT current_setting('timezone')",
    });
    console.log(result.rows[0]);
  },
);
```

### Transactions

```typescript
await withPgClient(null, async (client) => {
  await client.withTransaction(async (txClient) => {
    await txClient.query({
      text: "INSERT INTO users (name) VALUES ($1)",
      values: ["Alice"],
    });
    await txClient.query({
      text: "INSERT INTO posts (title) VALUES ($1)",
      values: ["Hello"],
    });
    // Automatically commits if no errors, rolls back if errors
  });
});
```

### Superuser Connections

For administrative operations, simply create a separate adapter with superuser
credentials:

```typescript
import { createNodePostgresAdapter } from "@graphile/pg-adapters/node-postgres";

// Regular connection
const withPgClient = createNodePostgresAdapter({
  connectionString: "postgresql://user:pass@localhost/db",
});

// Superuser connection for admin operations
const withSuperuserClient = createNodePostgresAdapter({
  connectionString: "postgresql://admin:adminpass@localhost/db",
});
```

## Configuration Options

Each adapter has its own specific configuration interface tailored to the
underlying database driver's capabilities.

### Node.js (pg) Configuration

```typescript
interface NodePostgresAdapterConfig {
  connectionString?: string; // PostgreSQL connection string
  pool?: Pool; // Use existing pool
  poolConfig?: PoolConfig; // Additional pool options
  maxConnections?: number; // Maximum connections in pool
  connectionTimeoutMs?: number; // Connection timeout in milliseconds
  queryTimeoutMs?: number; // Query timeout in milliseconds
}
```

### Postgres.js Configuration

```typescript
interface PostgresJsAdapterConfig {
  connectionString?: string; // PostgreSQL connection string
  sql?: Sql; // Use existing connection
  maxConnections?: number; // Maximum connections in pool
  connectionTimeoutSeconds?: number; // Connection timeout in seconds
  postgresOptions?: Options; // Additional postgres.js options
}
```

### PGlite Configuration

```typescript
interface PGliteAdapterConfig {
  pglite?: PGlite; // Use existing instance
  dataDir?: string; // Database directory or ":memory:"
  pgliteOptions?: PGliteOptions; // Additional PGlite options
}
```

Note: PGlite doesn't support connection pooling as it's single-threaded WASM.

### Node.js (pg) Specific Options

```typescript
interface NodePostgresAdapterConfig extends PgAdapterConfig {
  pool?: Pool; // Use existing pool
  poolConfig?: PoolConfig; // Additional pool options
}
```

### Postgres.js Specific Options

```typescript
interface PostgresJsAdapterConfig extends PgAdapterConfig {
  sql?: Sql; // Use existing connection
  postgresOptions?: Options; // Additional postgres.js options
}
```

### PGlite Specific Options

```typescript
interface PGliteAdapterConfig extends PgAdapterConfig {
  pglite?: PGlite; // Use existing instance
  dataDir?: string; // Database directory
  pgliteOptions?: PGliteOptions; // Additional PGlite options
}
```

## Environment Variables

### Node.js (pg) Adapter

- `PG_PREPARED_STATEMENT_CACHE_SIZE` - Number of prepared statements to cache
  (default: 100, set to 0 to disable)

## TypeScript Support

All adapters are fully typed with TypeScript. The package exports type
definitions for all interfaces and configuration options.

```typescript
import type {
  PgClient,
  WithPgClient,
  NodePostgresAdapterConfig,
} from "@graphile/pg-adapters";
```

## Error Handling

All adapters throw standard JavaScript errors. Database-specific errors are
passed through from the underlying drivers.

```typescript
try {
  await withPgClient(null, async (client) => {
    await client.query({ text: "INVALID SQL" });
  });
} catch (error) {
  console.error("Database error:", error.message);
}
```

## License

MIT
