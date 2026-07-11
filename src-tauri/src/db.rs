use std::{collections::HashSet, path::PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        DiscoveredService, LogSourceDto, ManagedService, OperationHistoryDto, PortBindingDto,
        ResourceMetricPointDto, ServiceDetailDto, ServiceSnapshot, ServiceStatus,
        ServiceSummaryDto,
    },
};

const MIGRATION_001: &str = r#"
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  service_name TEXT NOT NULL,
  formula TEXT NOT NULL,
  status TEXT NOT NULL,
  user TEXT,
  plist_path TEXT,
  file_path TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  provider_metadata TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(provider, service_name)
);

CREATE TABLE IF NOT EXISTS service_snapshots (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  cpu_percent REAL,
  memory_bytes INTEGER,
  uptime_seconds INTEGER,
  error_message TEXT,
  captured_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES services(id)
);

CREATE TABLE IF NOT EXISTS system_resource_snapshots (
  id TEXT PRIMARY KEY,
  cpu_percent REAL NOT NULL,
  memory_bytes INTEGER NOT NULL,
  total_memory_bytes INTEGER,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_history (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_summary TEXT NOT NULL,
  stderr_summary TEXT NOT NULL,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  FOREIGN KEY(service_id) REFERENCES services(id)
);

CREATE TABLE IF NOT EXISTS service_ports (
  id TEXT PRIMARY KEY,
  service_id TEXT,
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  address TEXT NOT NULL,
  process_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_sources (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  path TEXT NOT NULL,
  source_type TEXT NOT NULL,
  readable INTEGER NOT NULL,
  FOREIGN KEY(service_id) REFERENCES services(id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

const MIGRATION_002: &str = r#"
CREATE INDEX IF NOT EXISTS idx_service_snapshots_service_captured
  ON service_snapshots(service_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_snapshots_captured
  ON service_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_system_snapshots_captured
  ON system_resource_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_operation_history_started
  ON operation_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_history_service_started
  ON operation_history(service_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_removed
  ON services(removed_at);
PRAGMA user_version = 2;
"#;

const METRIC_RETENTION_HOURS: i64 = 25;
const OPERATION_RETENTION_DAYS: i64 = 90;
const REMOVED_SERVICE_RETENTION_DAYS: i64 = 90;
const MAX_OPERATION_HISTORY_ROWS: i64 = 10_000;
const MAX_OPERATION_OUTPUT_CHARS: usize = 16_384;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupResult {
    pub service_snapshots: usize,
    pub system_snapshots: usize,
    pub operation_history: usize,
    pub removed_services: usize,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        configure_connection(&conn)?;
        let database = Self { conn };
        database.migrate()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        configure_connection(&conn)?;
        let database = Self { conn };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&self) -> AppResult<()> {
        self.conn.execute_batch(MIGRATION_001)?;
        let mut columns = self.conn.prepare("PRAGMA table_info(services)")?;
        let names = columns
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !names.iter().any(|name| name == "removed_at") {
            self.conn
                .execute("ALTER TABLE services ADD COLUMN removed_at TEXT", [])?;
        }
        let mut columns = self
            .conn
            .prepare("PRAGMA table_info(system_resource_snapshots)")?;
        let names = columns
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !names.iter().any(|name| name == "total_memory_bytes") {
            self.conn.execute(
                "ALTER TABLE system_resource_snapshots ADD COLUMN total_memory_bytes INTEGER",
                [],
            )?;
        }
        self.conn.execute_batch(MIGRATION_002)?;
        Ok(())
    }

    pub fn clear_monitoring_data(&mut self) -> AppResult<usize> {
        let tx = self.conn.transaction()?;
        let service_count = tx.execute("DELETE FROM service_snapshots", [])?;
        let system_count = tx.execute("DELETE FROM system_resource_snapshots", [])?;
        tx.commit()?;
        Ok(service_count + system_count)
    }

    pub fn clear_operation_history(&mut self) -> AppResult<usize> {
        Ok(self.conn.execute("DELETE FROM operation_history", [])?)
    }

    pub fn cleanup_expired_data(&mut self, now: DateTime<Utc>) -> AppResult<CleanupResult> {
        let metric_cutoff = (now - chrono::Duration::hours(METRIC_RETENTION_HOURS)).to_rfc3339();
        let operation_cutoff =
            (now - chrono::Duration::days(OPERATION_RETENTION_DAYS)).to_rfc3339();
        let removed_cutoff =
            (now - chrono::Duration::days(REMOVED_SERVICE_RETENTION_DAYS)).to_rfc3339();
        let tx = self.conn.transaction()?;
        let service_snapshots = tx.execute(
            "DELETE FROM service_snapshots WHERE captured_at < ?1",
            params![metric_cutoff],
        )?;
        let system_snapshots = tx.execute(
            "DELETE FROM system_resource_snapshots WHERE captured_at < ?1",
            params![metric_cutoff],
        )?;
        let expired_operations = tx.execute(
            "DELETE FROM operation_history WHERE started_at < ?1",
            params![operation_cutoff],
        )?;
        let excess_operations = tx.execute(
            "DELETE FROM operation_history WHERE id IN (
                SELECT id FROM operation_history
                ORDER BY started_at DESC LIMIT -1 OFFSET ?1
             )",
            params![MAX_OPERATION_HISTORY_ROWS],
        )?;
        let removed_services = tx.execute(
            "DELETE FROM services
             WHERE removed_at IS NOT NULL AND removed_at < ?1
               AND NOT EXISTS (
                 SELECT 1 FROM operation_history WHERE operation_history.service_id = services.id
               )",
            params![removed_cutoff],
        )?;
        tx.commit()?;
        self.conn.execute_batch("PRAGMA optimize;")?;
        Ok(CleanupResult {
            service_snapshots,
            system_snapshots,
            operation_history: expired_operations + excess_operations,
            removed_services,
        })
    }

    pub fn upsert_discovered_services(&mut self, services: &[DiscoveredService]) -> AppResult<()> {
        let tx = self.conn.transaction()?;
        for service in services {
            let existing_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM services WHERE provider = ?1 AND service_name = ?2",
                    params![service.provider, service.service_name],
                    |row| row.get(0),
                )
                .optional()?;
            let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            tx.execute(
                "INSERT INTO services (
                    id, provider, service_name, formula, status, user, plist_path, file_path,
                    provider_metadata, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(provider, service_name) DO UPDATE SET
                    formula = excluded.formula,
                    status = excluded.status,
                    user = excluded.user,
                    plist_path = excluded.plist_path,
                    file_path = excluded.file_path,
                    provider_metadata = excluded.provider_metadata,
                    updated_at = excluded.updated_at,
                    removed_at = NULL",
                params![
                    id,
                    service.provider,
                    service.service_name,
                    service.formula,
                    status_to_string(&service.status),
                    service.user,
                    service.plist_path,
                    service.file_path,
                    service.provider_metadata.to_string(),
                    Utc::now().to_rfc3339()
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_services(&self) -> AppResult<Vec<ManagedService>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider, service_name, formula, status, user, plist_path, file_path,
                    favorite, note, provider_metadata, updated_at
             FROM services WHERE removed_at IS NULL ORDER BY provider, service_name",
        )?;
        let rows = stmt.query_map([], map_service_row)?;
        collect_rows(rows)
    }

    pub fn get_service(&self, service_id: &str) -> AppResult<ManagedService> {
        self.conn
            .query_row(
                "SELECT id, provider, service_name, formula, status, user, plist_path, file_path,
                        favorite, note, provider_metadata, updated_at
                 FROM services WHERE id = ?1 AND removed_at IS NULL",
                params![service_id],
                map_service_row,
            )
            .optional()?
            .ok_or_else(|| AppError::ServiceNotFound(service_id.to_string()))
    }

    pub fn list_service_summaries(&self) -> AppResult<Vec<ServiceSummaryDto>> {
        let services = self.list_services()?;
        let ports = self.list_ports()?;
        let mut summaries = Vec::new();
        for service in services {
            let latest = self.latest_snapshot(service.id.as_str())?;
            let mut seen_ports = HashSet::new();
            let service_ports: Vec<i64> = ports
                .iter()
                .filter(|port| port.service_id.as_deref() == Some(service.id.as_str()))
                .map(|port| port.port)
                .filter(|port| seen_ports.insert(*port))
                .collect();
            summaries.push(ServiceSummaryDto {
                id: service.id,
                provider: service.provider,
                service_name: service.service_name,
                formula: service.formula,
                status: service.status,
                user: service.user,
                ports: service_ports,
                pid: latest.as_ref().and_then(|snapshot| snapshot.pid),
                cpu_percent: latest.as_ref().and_then(|snapshot| snapshot.cpu_percent),
                memory_bytes: latest.as_ref().and_then(|snapshot| snapshot.memory_bytes),
                uptime_seconds: latest.as_ref().and_then(|snapshot| snapshot.uptime_seconds),
                updated_at: service.updated_at,
            });
        }
        Ok(summaries)
    }

    pub fn get_service_detail(&self, service_id: &str) -> AppResult<ServiceDetailDto> {
        let service = self.get_service(service_id)?;
        let latest_snapshot = self.latest_snapshot(service_id)?;
        let mut seen_ports = HashSet::new();
        let ports = self
            .list_ports()?
            .into_iter()
            .filter(|port| port.service_id.as_deref() == Some(service_id))
            .filter(|port| seen_ports.insert(port.port))
            .collect();
        let log_sources = self.list_log_sources(service_id)?;
        let history = self.list_operation_history_for_service(service_id)?;
        Ok(ServiceDetailDto {
            command_preview: vec![
                "brew".to_string(),
                "services".to_string(),
                "restart".to_string(),
                service.service_name.clone(),
            ],
            service,
            latest_snapshot,
            ports,
            log_sources,
            history,
        })
    }

    pub fn insert_snapshot(&self, snapshot: &ServiceSnapshot) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO service_snapshots (
                id, service_id, status, pid, cpu_percent, memory_bytes, uptime_seconds,
                error_message, captured_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                Uuid::new_v4().to_string(),
                snapshot.service_id,
                status_to_string(&snapshot.status),
                snapshot.pid,
                snapshot.cpu_percent,
                snapshot.memory_bytes,
                snapshot.uptime_seconds,
                snapshot.error_message,
                snapshot.captured_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list_resource_metrics(
        &self,
        since: DateTime<Utc>,
        bucket_seconds: i64,
    ) -> AppResult<Vec<ResourceMetricPointDto>> {
        let mut stmt = self.conn.prepare(
            "SELECT service_id, AVG(cpu_percent), CAST(AVG(memory_bytes) AS INTEGER),
                    MAX(captured_at)
             FROM service_snapshots
             WHERE captured_at >= ?1 AND (cpu_percent IS NOT NULL OR memory_bytes IS NOT NULL)
             GROUP BY service_id, CAST(strftime('%s', captured_at) AS INTEGER) / ?2
             ORDER BY captured_at ASC",
        )?;
        let rows = stmt.query_map(params![since.to_rfc3339(), bucket_seconds.max(1)], |row| {
            Ok(ResourceMetricPointDto {
                service_id: row.get(0)?,
                cpu_percent: row.get(1)?,
                memory_bytes: row.get(2)?,
                total_memory_bytes: None,
                captured_at: parse_datetime(row.get::<_, String>(3)?.as_str())?,
            })
        })?;
        collect_rows(rows)
    }

    pub fn insert_system_resource_metric(&self, metric: &ResourceMetricPointDto) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO system_resource_snapshots (id, cpu_percent, memory_bytes, total_memory_bytes, captured_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                Uuid::new_v4().to_string(),
                metric.cpu_percent,
                metric.memory_bytes,
                metric.total_memory_bytes,
                metric.captured_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list_system_resource_metrics(
        &self,
        since: DateTime<Utc>,
        bucket_seconds: i64,
    ) -> AppResult<Vec<ResourceMetricPointDto>> {
        let mut stmt = self.conn.prepare(
            "SELECT AVG(cpu_percent), CAST(AVG(memory_bytes) AS INTEGER), MAX(total_memory_bytes), MAX(captured_at)
             FROM system_resource_snapshots WHERE captured_at >= ?1
             GROUP BY CAST(strftime('%s', captured_at) AS INTEGER) / ?2 ORDER BY captured_at ASC",
        )?;
        let rows = stmt.query_map(params![since.to_rfc3339(), bucket_seconds.max(1)], |row| {
            Ok(ResourceMetricPointDto {
                service_id: "system".into(),
                cpu_percent: row.get(0)?,
                memory_bytes: row.get(1)?,
                total_memory_bytes: row.get(2)?,
                captured_at: parse_datetime(row.get::<_, String>(3)?.as_str())?,
            })
        })?;
        collect_rows(rows)
    }

    pub fn mark_service_removed(&mut self, service_id: &str) -> AppResult<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE services SET removed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![service_id, Utc::now().to_rfc3339()],
        )?;
        tx.execute(
            "DELETE FROM service_snapshots WHERE service_id = ?1",
            params![service_id],
        )?;
        tx.execute(
            "DELETE FROM service_ports WHERE service_id = ?1",
            params![service_id],
        )?;
        tx.execute(
            "DELETE FROM log_sources WHERE service_id = ?1",
            params![service_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn replace_ports(&mut self, ports: &[PortBindingDto]) -> AppResult<()> {
        let services = self.list_services()?;
        let attached = crate::system_probe::attach_ports_to_services(&services, ports);
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM service_ports", [])?;
        for port in ports {
            let mut service_id = None;
            for matches in attached.values() {
                if let Some(matched) = matches.iter().find(|candidate| {
                    candidate.pid == port.pid
                        && candidate.port == port.port
                        && candidate.address == port.address
                }) {
                    service_id = matched.service_id.clone();
                    break;
                }
            }
            tx.execute(
                "INSERT INTO service_ports (id, service_id, pid, port, protocol, address, process_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    Uuid::new_v4().to_string(),
                    service_id,
                    port.pid,
                    port.port,
                    port.protocol,
                    port.address,
                    port.process_name
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_ports(&self) -> AppResult<Vec<PortBindingDto>> {
        let mut stmt = self.conn.prepare(
            "SELECT service_id, pid, port, protocol, address, process_name
             FROM service_ports ORDER BY port ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PortBindingDto {
                service_id: row.get(0)?,
                pid: row.get(1)?,
                port: row.get(2)?,
                protocol: row.get(3)?,
                address: row.get(4)?,
                process_name: row.get(5)?,
            })
        })?;
        collect_rows(rows)
    }

    pub fn replace_log_sources(
        &mut self,
        service_id: &str,
        sources: &[LogSourceDto],
    ) -> AppResult<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM log_sources WHERE service_id = ?1",
            params![service_id],
        )?;
        for source in sources {
            tx.execute(
                "INSERT INTO log_sources (id, service_id, path, source_type, readable)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    service_id,
                    source.path,
                    source.source_type,
                    source.readable as i64
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_log_sources(&self, service_id: &str) -> AppResult<Vec<LogSourceDto>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service_id, path, source_type, readable
             FROM log_sources WHERE service_id = ?1 ORDER BY readable DESC, path ASC",
        )?;
        let rows = stmt.query_map(params![service_id], |row| {
            Ok(LogSourceDto {
                id: row.get(0)?,
                service_id: row.get(1)?,
                path: row.get(2)?,
                source_type: row.get(3)?,
                readable: row.get::<_, i64>(4)? == 1,
            })
        })?;
        collect_rows(rows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_operation(
        &self,
        service_id: &str,
        provider: &str,
        operation_type: &str,
        command: &[String],
        exit_code: i32,
        duration_ms: i64,
        stdout: &str,
        stderr: &str,
        error_message: Option<&str>,
    ) -> AppResult<OperationHistoryDto> {
        let finished_at = Utc::now();
        let duration_ms = duration_ms.max(0);
        let started_at = finished_at - chrono::Duration::milliseconds(duration_ms);
        let operation = OperationHistoryDto {
            id: Uuid::new_v4().to_string(),
            service_id: service_id.to_string(),
            provider: provider.to_string(),
            operation_type: operation_type.to_string(),
            command: command.to_vec(),
            exit_code: exit_code as i64,
            stdout_summary: summarize(stdout),
            stderr_summary: summarize(stderr),
            error_message: error_message.map(ToString::to_string),
            started_at,
            finished_at,
            duration_ms,
        };
        self.conn.execute(
            "INSERT INTO operation_history (
                id, service_id, provider, operation_type, command, exit_code,
                stdout_summary, stderr_summary, error_message, started_at, finished_at, duration_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                operation.id,
                operation.service_id,
                operation.provider,
                operation.operation_type,
                serde_json::to_string(&operation.command).unwrap_or_default(),
                operation.exit_code,
                operation.stdout_summary,
                operation.stderr_summary,
                operation.error_message,
                operation.started_at.to_rfc3339(),
                operation.finished_at.to_rfc3339(),
                operation.duration_ms
            ],
        )?;
        Ok(operation)
    }

    pub fn list_operation_history(&self) -> AppResult<Vec<OperationHistoryDto>> {
        self.query_operation_history(
            "SELECT id, service_id, provider, operation_type, command, exit_code,
                    stdout_summary, stderr_summary, error_message, started_at, finished_at, duration_ms
             FROM operation_history ORDER BY started_at DESC LIMIT 200",
            [],
        )
    }

    fn list_operation_history_for_service(
        &self,
        service_id: &str,
    ) -> AppResult<Vec<OperationHistoryDto>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service_id, provider, operation_type, command, exit_code,
                    stdout_summary, stderr_summary, error_message, started_at, finished_at, duration_ms
             FROM operation_history WHERE service_id = ?1 ORDER BY started_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(params![service_id], map_operation_row)?;
        collect_rows(rows)
    }

    fn query_operation_history<P>(
        &self,
        sql: &str,
        params: P,
    ) -> AppResult<Vec<OperationHistoryDto>>
    where
        P: rusqlite::Params,
    {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, map_operation_row)?;
        collect_rows(rows)
    }

    fn latest_snapshot(&self, service_id: &str) -> AppResult<Option<ServiceSnapshot>> {
        self.conn
            .query_row(
                "SELECT service_id, status, pid, cpu_percent, memory_bytes, uptime_seconds,
                        error_message, captured_at
                 FROM service_snapshots WHERE service_id = ?1 ORDER BY captured_at DESC LIMIT 1",
                params![service_id],
                |row| {
                    Ok(ServiceSnapshot {
                        service_id: row.get(0)?,
                        status: string_to_status(row.get::<_, String>(1)?.as_str()),
                        pid: row.get(2)?,
                        cpu_percent: row.get(3)?,
                        memory_bytes: row.get(4)?,
                        uptime_seconds: row.get(5)?,
                        error_message: row.get(6)?,
                        captured_at: parse_datetime(row.get::<_, String>(7)?.as_str())?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }
}

fn map_service_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ManagedService> {
    let metadata: String = row.get(10)?;
    Ok(ManagedService {
        id: row.get(0)?,
        provider: row.get(1)?,
        service_name: row.get(2)?,
        formula: row.get(3)?,
        status: string_to_status(row.get::<_, String>(4)?.as_str()),
        user: row.get(5)?,
        plist_path: row.get(6)?,
        file_path: row.get(7)?,
        favorite: row.get::<_, i64>(8)? == 1,
        note: row.get(9)?,
        provider_metadata: serde_json::from_str(metadata.as_str()).unwrap_or_default(),
        updated_at: parse_datetime(row.get::<_, String>(11)?.as_str())?,
    })
}

fn map_operation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OperationHistoryDto> {
    let command: String = row.get(4)?;
    Ok(OperationHistoryDto {
        id: row.get(0)?,
        service_id: row.get(1)?,
        provider: row.get(2)?,
        operation_type: row.get(3)?,
        command: serde_json::from_str(command.as_str()).unwrap_or_default(),
        exit_code: row.get(5)?,
        stdout_summary: row.get(6)?,
        stderr_summary: row.get(7)?,
        error_message: row.get(8)?,
        started_at: parse_datetime(row.get::<_, String>(9)?.as_str())?,
        finished_at: parse_datetime(row.get::<_, String>(10)?.as_str())?,
        duration_ms: row.get(11)?,
    })
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> AppResult<Vec<T>> {
    rows.collect::<rusqlite::Result<Vec<T>>>()
        .map_err(Into::into)
}

fn status_to_string(status: &ServiceStatus) -> &'static str {
    match status {
        ServiceStatus::Running => "running",
        ServiceStatus::Stopped => "stopped",
        ServiceStatus::Error => "error",
        ServiceStatus::Unknown => "unknown",
    }
}

fn string_to_status(value: &str) -> ServiceStatus {
    match value {
        "running" => ServiceStatus::Running,
        "stopped" => ServiceStatus::Stopped,
        "error" => ServiceStatus::Error,
        _ => ServiceStatus::Unknown,
    }
}

fn parse_datetime(value: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
        })
}

fn summarize(value: &str) -> String {
    let value = value.trim();
    if value.chars().count() <= MAX_OPERATION_OUTPUT_CHARS {
        return value.to_string();
    }
    let mut summary = value
        .chars()
        .take(MAX_OPERATION_OUTPUT_CHARS)
        .collect::<String>();
    summary.push_str("\n…[truncated]");
    summary
}

fn configure_connection(conn: &Connection) -> AppResult<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sample_service(name: &str, status: ServiceStatus) -> DiscoveredService {
        DiscoveredService {
            provider: "homebrew".to_string(),
            service_name: name.to_string(),
            formula: name.to_string(),
            status,
            user: Some("luky".to_string()),
            plist_path: Some(format!("/tmp/{name}.plist")),
            file_path: Some(format!("/tmp/{name}.plist")),
            provider_metadata: json!({ "raw_status": "started" }),
        }
    }

    #[test]
    fn migration_runs_on_empty_database() {
        let database = Database::in_memory().expect("database");
        let services = database.list_services().expect("services");
        assert!(services.is_empty());
    }

    #[test]
    fn upserts_discovered_services_without_losing_user_fields() {
        let mut database = Database::in_memory().expect("database");
        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Running)])
            .expect("insert");
        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Stopped)])
            .expect("update");

        let services = database.list_services().expect("services");
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].status, ServiceStatus::Stopped);
    }

    #[test]
    fn removed_services_are_hidden_and_reappear_if_discovered_again() {
        let mut database = Database::in_memory().expect("database");
        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Running)])
            .expect("insert");
        let service_id = database.list_services().expect("services")[0].id.clone();

        database
            .mark_service_removed(&service_id)
            .expect("mark removed");
        assert!(database.list_services().expect("services").is_empty());
        assert!(database.get_service(&service_id).is_err());

        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Stopped)])
            .expect("rediscover");
        assert_eq!(database.list_services().expect("services").len(), 1);
    }

    #[test]
    fn returns_bucketed_resource_metrics_for_recent_snapshots() {
        let mut database = Database::in_memory().expect("database");
        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Running)])
            .expect("insert");
        let service_id = database.list_services().expect("services")[0].id.clone();
        let captured_at = Utc::now();
        database
            .insert_snapshot(&ServiceSnapshot {
                service_id: service_id.clone(),
                status: ServiceStatus::Running,
                pid: Some(123),
                cpu_percent: Some(4.2),
                memory_bytes: Some(64 * 1024 * 1024),
                uptime_seconds: Some(120),
                error_message: None,
                captured_at,
            })
            .expect("snapshot");

        let metrics = database
            .list_resource_metrics(Utc::now() - chrono::Duration::minutes(5), 10)
            .expect("metrics");

        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].service_id, service_id);
        assert_eq!(metrics[0].cpu_percent, Some(4.2));
        assert_eq!(metrics[0].memory_bytes, Some(64 * 1024 * 1024));
    }

    #[test]
    fn records_operation_history() {
        let mut database = Database::in_memory().expect("database");
        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Running)])
            .expect("insert");
        let service = database.list_services().expect("services").remove(0);
        let complete_output = "x".repeat(2_000);
        database
            .record_operation(
                service.id.as_str(),
                "homebrew",
                "restart",
                &[
                    "brew".into(),
                    "services".into(),
                    "restart".into(),
                    "redis".into(),
                ],
                0,
                10,
                &complete_output,
                "",
                None,
            )
            .expect("record");

        let history = database.list_operation_history().expect("history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].operation_type, "restart");
        assert_eq!(history[0].command[3], "redis");
        assert_eq!(history[0].stdout_summary, complete_output);
        assert_eq!(history[0].duration_ms, 10);
    }

    #[test]
    fn cleanup_removes_expired_metrics_and_audit_records() {
        let mut database = Database::in_memory().expect("database");
        database
            .upsert_discovered_services(&[sample_service("redis", ServiceStatus::Running)])
            .expect("insert");
        let service = database.list_services().expect("services").remove(0);
        let now = Utc::now();
        for captured_at in [now - chrono::Duration::hours(26), now] {
            database
                .insert_snapshot(&ServiceSnapshot {
                    service_id: service.id.clone(),
                    status: ServiceStatus::Running,
                    pid: Some(123),
                    cpu_percent: Some(1.0),
                    memory_bytes: Some(1024),
                    uptime_seconds: Some(1),
                    error_message: None,
                    captured_at,
                })
                .expect("snapshot");
            database
                .insert_system_resource_metric(&ResourceMetricPointDto {
                    service_id: "system".into(),
                    cpu_percent: Some(1.0),
                    memory_bytes: Some(1024),
                    total_memory_bytes: Some(2048),
                    captured_at,
                })
                .expect("system snapshot");
        }
        let operation = database
            .record_operation(
                &service.id,
                "homebrew",
                "restart",
                &["brew".into()],
                0,
                1,
                "ok",
                "",
                None,
            )
            .expect("operation");
        database
            .conn
            .execute(
                "UPDATE operation_history SET started_at = ?2 WHERE id = ?1",
                params![
                    operation.id,
                    (now - chrono::Duration::days(91)).to_rfc3339()
                ],
            )
            .expect("age operation");

        let result = database.cleanup_expired_data(now).expect("cleanup");

        assert_eq!(result.service_snapshots, 1);
        assert_eq!(result.system_snapshots, 1);
        assert_eq!(result.operation_history, 1);
        assert_eq!(
            database
                .conn
                .query_row("SELECT COUNT(*) FROM service_snapshots", [], |row| row
                    .get::<_, i64>(0))
                .expect("service count"),
            1
        );
    }

    #[test]
    fn operation_output_is_bounded_without_breaking_unicode() {
        let output = "数".repeat(MAX_OPERATION_OUTPUT_CHARS + 1);
        let summary = summarize(&output);

        assert!(summary.ends_with("…[truncated]"));
        assert!(summary.chars().count() < output.chars().count() + 20);
    }
}
