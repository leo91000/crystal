# @graphile/pg-adapters

## 0.0.1-beta.1

### Features

- Initial release of PostgreSQL adapters package
- Support for node-postgres (`pg`) adapter with connection pooling and prepared
  statement caching
- Support for postgres.js adapter with modern async/await API
- Support for PGlite adapter for WASM PostgreSQL in Node.js and browsers
- Unified `PgClient` interface across all adapters
- Transaction support for all adapters
- PostgreSQL settings support for session configuration
- Subpath exports for tree-shaking and optional dependencies
- TypeScript support with full type definitions
- Simple approach for admin connections (create separate adapter instances)
