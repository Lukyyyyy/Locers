use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Running,
    Stopped,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedService {
    pub id: String,
    pub provider: String,
    pub service_name: String,
    pub formula: String,
    pub status: ServiceStatus,
    pub user: Option<String>,
    pub plist_path: Option<String>,
    pub file_path: Option<String>,
    pub favorite: bool,
    pub note: Option<String>,
    pub provider_metadata: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredService {
    pub provider: String,
    pub service_name: String,
    pub formula: String,
    pub status: ServiceStatus,
    pub user: Option<String>,
    pub plist_path: Option<String>,
    pub file_path: Option<String>,
    pub provider_metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceSnapshot {
    pub service_id: String,
    pub status: ServiceStatus,
    pub pid: Option<i64>,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<i64>,
    pub uptime_seconds: Option<i64>,
    pub error_message: Option<String>,
    pub captured_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceMetricPointDto {
    pub service_id: String,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<i64>,
    pub total_memory_bytes: Option<i64>,
    pub captured_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortBindingDto {
    pub service_id: Option<String>,
    pub pid: i64,
    pub port: i64,
    pub protocol: String,
    pub address: String,
    pub process_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSourceDto {
    pub id: Option<String>,
    pub service_id: String,
    pub path: String,
    pub source_type: String,
    pub readable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationHistoryDto {
    pub id: String,
    pub service_id: String,
    pub provider: String,
    pub operation_type: String,
    pub command: Vec<String>,
    pub exit_code: i64,
    pub stdout_summary: String,
    pub stderr_summary: String,
    pub error_message: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceSummaryDto {
    pub id: String,
    pub provider: String,
    pub service_name: String,
    pub formula: String,
    pub status: ServiceStatus,
    pub user: Option<String>,
    pub ports: Vec<i64>,
    pub pid: Option<i64>,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<i64>,
    pub uptime_seconds: Option<i64>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceDetailDto {
    pub service: ManagedService,
    pub latest_snapshot: Option<ServiceSnapshot>,
    pub ports: Vec<PortBindingDto>,
    pub log_sources: Vec<LogSourceDto>,
    pub history: Vec<OperationHistoryDto>,
    pub command_preview: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshResultDto {
    pub discovered_count: i64,
    pub duration_ms: i64,
    pub refreshed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortRefreshResultDto {
    pub refreshed_count: i64,
    pub duration_ms: i64,
    pub refreshed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeMetricsRefreshResultDto {
    pub refreshed_count: i64,
    pub duration_ms: i64,
    pub refreshed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfoDto {
    pub version: String,
    pub database_path: String,
    pub database_size_bytes: i64,
    pub provider: String,
    pub metric_retention_hours: i64,
    pub operation_retention_days: i64,
    pub operation_history_limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataCleanupResultDto {
    pub deleted_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationResultDto {
    pub operation: OperationHistoryDto,
    pub command: Vec<String>,
    pub success: bool,
    pub refresh: RefreshResultDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaStatusDto {
    pub formula: String,
    pub installed: bool,
    pub version: Option<String>,
    pub outdated: bool,
    pub current_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaInstallResultDto {
    pub formula: String,
    pub command: Vec<String>,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub service_id: Option<String>,
}

pub type FormulaUpgradeResultDto = FormulaInstallResultDto;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogReadOptionsDto {
    pub max_lines: Option<usize>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogReadResultDto {
    pub source: Option<LogSourceDto>,
    pub lines: Vec<String>,
    pub error: Option<String>,
}
