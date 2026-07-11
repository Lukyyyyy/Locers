# Locers Storage Policy

This document is the source of truth for data classification, persistence, retention, and cleanup.

## Storage principles

1. Persist user intent, audit evidence, and data that is expensive or impossible to reconstruct.
2. Keep live process state and UI query results in memory.
3. Store only the latest copy of machine state that can be reconstructed cheaply.
4. Put every append-only dataset under both a time limit and, where appropriate, a row or size limit.
5. Do not copy service log contents into the application database.

## Data lifecycle

| Data                                | Storage                            | Retention                     | Cleanup                                                               |
| ----------------------------------- | ---------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| Discovered services and user fields | SQLite `services`                  | Active lifetime               | Soft-delete on uninstall                                              |
| Removed services                    | SQLite `services`                  | 90 days minimum               | Delete after 90 days only when no audit record references the service |
| Service resource samples            | SQLite `service_snapshots`         | 25 hours                      | Startup and every 6 hours                                             |
| System resource samples             | SQLite `system_resource_snapshots` | 25 hours                      | Startup and every 6 hours                                             |
| Operation audit history             | SQLite `operation_history`         | 90 days, maximum 10,000 rows  | Startup and every 6 hours                                             |
| Operation stdout/stderr summaries   | SQLite `operation_history`         | Same as audit history         | Each stream is limited to 16,384 Unicode characters before insertion  |
| Listening ports                     | SQLite `service_ports`             | Latest scan only              | Replace atomically on refresh                                         |
| Log source paths                    | SQLite `log_sources`               | Latest discovery only         | Replace atomically on refresh                                         |
| Service log contents                | Original service log files         | Owned by the service          | Never copied into Locers SQLite                                       |
| Runtime metric cache                | Rust process memory                | Process lifetime              | Replaced by new samples                                               |
| Log session offsets                 | Rust process memory                | Process lifetime/session      | Removed with the service or on restart                                |
| API/query cache                     | Browser process memory             | UI process lifetime           | Invalidated after mutations; garbage-collected by TanStack Query      |
| UI language                         | Browser local storage              | Until user/browser data reset | Key: `locers-ui`                                                      |
| Other UI state                      | Browser process memory             | UI process lifetime           | Not persisted                                                         |

## SQLite operating standard

- Database location: Tauri application data directory, filename `locers.sqlite3`.
- Schema version: SQLite `PRAGMA user_version`.
- Foreign keys: enabled for every connection.
- Journal mode: WAL for resilient concurrent reads and writes.
- Durability: `synchronous=NORMAL`, appropriate for reproducible local monitoring samples.
- Lock handling: 5-second busy timeout.
- Maintenance: `PRAGMA optimize` after retention cleanup.
- Required query paths have explicit timestamp and service/timestamp indexes.

## Rules for new data

Every new table or persisted field must document:

- business owner and purpose;
- whether it contains user intent, audit evidence, derived data, or ephemeral state;
- retention duration and maximum cardinality/size;
- deletion trigger and foreign-key behavior;
- whether the data may contain credentials, tokens, personal data, or raw logs;
- migration and rollback compatibility.

Append-only tables without a cleanup policy are not permitted. Secrets and authentication tokens must not be stored in this database without an OS keychain-backed design.
