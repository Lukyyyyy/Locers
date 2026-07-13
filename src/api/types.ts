export type ServiceStatus = "running" | "stopped" | "error" | "unknown";

export interface ServiceSummaryDto {
  id: string;
  provider: string;
  service_name: string;
  formula: string;
  status: ServiceStatus;
  user?: string | null;
  ports: number[];
  pid?: number | null;
  cpu_percent?: number | null;
  memory_bytes?: number | null;
  uptime_seconds?: number | null;
  updated_at: string;
}

export interface ManagedService {
  id: string;
  provider: string;
  service_name: string;
  formula: string;
  status: ServiceStatus;
  user?: string | null;
  plist_path?: string | null;
  file_path?: string | null;
  favorite: boolean;
  note?: string | null;
  provider_metadata: Record<string, unknown>;
  updated_at: string;
}

export interface ServiceSnapshot {
  service_id: string;
  status: ServiceStatus;
  pid?: number | null;
  cpu_percent?: number | null;
  memory_bytes?: number | null;
  uptime_seconds?: number | null;
  error_message?: string | null;
  captured_at: string;
}

export interface ResourceMetricPointDto {
  service_id: string;
  cpu_percent?: number | null;
  memory_bytes?: number | null;
  total_memory_bytes?: number | null;
  captured_at: string;
}

export interface PortBindingDto {
  service_id?: string | null;
  pid: number;
  port: number;
  protocol: string;
  address: string;
  process_name: string;
}

export interface LogSourceDto {
  id?: string | null;
  service_id: string;
  path: string;
  source_type: string;
  readable: boolean;
}

export interface OperationHistoryDto {
  id: string;
  service_id: string;
  provider: string;
  operation_type: string;
  command: string[];
  exit_code: number;
  stdout_summary: string;
  stderr_summary: string;
  error_message?: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface ServiceDetailDto {
  service: ManagedService;
  latest_snapshot?: ServiceSnapshot | null;
  ports: PortBindingDto[];
  log_sources: LogSourceDto[];
  history: OperationHistoryDto[];
  command_preview: string[];
}

export interface RefreshResultDto {
  discovered_count: number;
  duration_ms: number;
  refreshed_at: string;
}

export interface PortRefreshResultDto {
  refreshed_count: number;
  duration_ms: number;
  refreshed_at: string;
}

export interface RuntimeMetricsRefreshResultDto {
  refreshed_count: number;
  duration_ms: number;
  refreshed_at: string;
}

export interface AppInfoDto {
  version: string;
  database_path: string;
  database_size_bytes: number;
  provider: string;
  metric_retention_hours: number;
  operation_retention_days: number;
  operation_history_limit: number;
}

export interface DataCleanupResultDto {
  deleted_count: number;
}

export interface OperationResultDto {
  operation: OperationHistoryDto;
  command: string[];
  success: boolean;
  refresh: RefreshResultDto;
}

export interface FormulaStatusDto {
  formula: string;
  installed: boolean;
  version?: string | null;
  outdated: boolean;
  current_version?: string | null;
}

export interface FormulaInstallResultDto {
  formula: string;
  command: string[];
  stdout: string;
  stderr: string;
  success: boolean;
  service_id?: string | null;
}

export type FormulaUpgradeResultDto = FormulaInstallResultDto;

export interface LogReadResultDto {
  source?: LogSourceDto | null;
  lines: string[];
  error?: string | null;
}
