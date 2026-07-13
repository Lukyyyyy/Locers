import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfoDto,
  DataCleanupResultDto,
  FormulaInstallResultDto,
  FormulaUpgradeResultDto,
  FormulaStatusDto,
  LogReadResultDto,
  OperationHistoryDto,
  OperationResultDto,
  PortBindingDto,
  PortRefreshResultDto,
  RefreshResultDto,
  ResourceMetricPointDto,
  RuntimeMetricsRefreshResultDto,
  ServiceDetailDto,
  ServiceSummaryDto
} from "./types";

const isTauriRuntime = () =>
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

const now = () => new Date().toISOString();

const demoServices: ServiceSummaryDto[] = [
  {
    id: "demo-elasticsearch",
    provider: "homebrew",
    service_name: "elasticsearch-full",
    formula: "elasticsearch-full",
    status: "running",
    user: "local",
    ports: [9200],
    pid: 7312,
    cpu_percent: 22.6,
    memory_bytes: 2.45 * 1024 * 1024 * 1024,
    uptime_seconds: 12_420,
    updated_at: now()
  },
  {
    id: "demo-postgres",
    provider: "homebrew",
    service_name: "postgresql@16",
    formula: "postgresql@16",
    status: "running",
    user: "local",
    ports: [5432],
    pid: 8421,
    cpu_percent: 13.7,
    memory_bytes: 812 * 1024 * 1024,
    uptime_seconds: 18_720,
    updated_at: now()
  },
  {
    id: "demo-redis",
    provider: "homebrew",
    service_name: "redis",
    formula: "redis",
    status: "running",
    user: "local",
    ports: [6379],
    pid: 9118,
    cpu_percent: 8.9,
    memory_bytes: 384 * 1024 * 1024,
    uptime_seconds: 10_080,
    updated_at: now()
  },
  {
    id: "demo-minio",
    provider: "homebrew",
    service_name: "minio",
    formula: "minio",
    status: "running",
    user: "local",
    ports: [9000],
    pid: 9550,
    cpu_percent: 3.2,
    memory_bytes: 156 * 1024 * 1024,
    uptime_seconds: 21_900,
    updated_at: now()
  }
];

export const api = {
  getFormulaStatuses: () =>
    isTauriRuntime()
      ? invoke<FormulaStatusDto[]>("get_formula_statuses")
      : Promise.resolve([
          { formula: "postgresql@16", installed: true, version: "16.4", outdated: false },
          {
            formula: "redis",
            installed: true,
            version: "8.8.0",
            outdated: true,
            current_version: "8.8.1"
          }
        ]),
  installFormula: (formula: string) =>
    isTauriRuntime()
      ? invoke<FormulaInstallResultDto>("install_formula", { formula })
      : Promise.resolve({
          formula,
          command: ["brew", "install", "--formula", formula],
          stdout: `Successfully installed ${formula}`,
          stderr: "",
          success: true,
          service_id: `demo-${formula}`
        }),
  upgradeFormula: (formula: string) =>
    isTauriRuntime()
      ? invoke<FormulaUpgradeResultDto>("upgrade_formula", { formula })
      : Promise.resolve({
          formula,
          command: ["brew", "upgrade", "--formula", formula],
          stdout: `Successfully upgraded ${formula}`,
          stderr: "",
          success: true,
          service_id: `demo-${formula}`
        }),
  getAppInfo: () =>
    isTauriRuntime()
      ? invoke<AppInfoDto>("get_app_info")
      : Promise.resolve({
          version: "0.1.0",
          database_path: "~/Library/Application Support/com.locers.app/locers.sqlite3",
          database_size_bytes: 2.4 * 1024 * 1024,
          provider: "Homebrew",
          metric_retention_hours: 25,
          operation_retention_days: 90,
          operation_history_limit: 10_000
        }),
  clearMonitoringData: () =>
    isTauriRuntime()
      ? invoke<DataCleanupResultDto>("clear_monitoring_data")
      : Promise.resolve({ deleted_count: 0 }),
  clearOperationHistory: () =>
    isTauriRuntime()
      ? invoke<DataCleanupResultDto>("clear_operation_history")
      : Promise.resolve({ deleted_count: 0 }),
  getServices: () =>
    isTauriRuntime() ? invoke<ServiceSummaryDto[]>("get_services") : Promise.resolve(demoServices),
  refreshServices: () =>
    isTauriRuntime()
      ? invoke<RefreshResultDto>("refresh_services")
      : Promise.resolve({
          discovered_count: demoServices.length,
          duration_ms: 12,
          refreshed_at: now()
        }),
  refreshRuntimeMetrics: () =>
    isTauriRuntime()
      ? invoke<RuntimeMetricsRefreshResultDto>("refresh_runtime_metrics")
      : Promise.resolve({
          refreshed_count: demoServices.length,
          duration_ms: 3,
          refreshed_at: now()
        }),
  getServiceDetail: (serviceId: string) =>
    isTauriRuntime()
      ? invoke<ServiceDetailDto>("get_service_detail", { serviceId })
      : Promise.resolve(demoDetail(serviceId)),
  startService: (serviceId: string) =>
    isTauriRuntime()
      ? invoke<OperationResultDto>("start_service", { serviceId })
      : demoOperation(serviceId, "start"),
  stopService: (serviceId: string) =>
    isTauriRuntime()
      ? invoke<OperationResultDto>("stop_service", { serviceId })
      : demoOperation(serviceId, "stop"),
  restartService: (serviceId: string) =>
    isTauriRuntime()
      ? invoke<OperationResultDto>("restart_service", { serviceId })
      : demoOperation(serviceId, "restart"),
  removeService: (serviceId: string) =>
    isTauriRuntime()
      ? invoke<OperationResultDto>("remove_service", { serviceId })
      : demoOperation(serviceId, "remove"),
  getServiceLogs: (serviceId: string, maxLines = 300, query = "") =>
    isTauriRuntime()
      ? invoke<LogReadResultDto>("get_service_logs", {
          serviceId,
          options: { max_lines: maxLines, query }
        })
      : Promise.resolve({
          source: null,
          lines: [],
          error: null
        }),
  getOperationHistory: () =>
    isTauriRuntime()
      ? invoke<OperationHistoryDto[]>("get_operation_history")
      : Promise.resolve(demoActivityHistory()),
  getResourceMetrics: (minutes: number) =>
    isTauriRuntime()
      ? invoke<ResourceMetricPointDto[]>("get_resource_metrics", { minutes })
      : Promise.resolve(demoResourceMetrics(minutes)),
  getSystemResourceMetrics: (minutes: number) =>
    isTauriRuntime()
      ? invoke<ResourceMetricPointDto[]>("get_system_resource_metrics", { minutes })
      : Promise.resolve(demoResourceMetrics(minutes)),
  getPorts: () =>
    isTauriRuntime()
      ? invoke<PortBindingDto[]>("get_ports")
      : Promise.resolve([
          {
            service_id: "demo-postgres",
            pid: 8421,
            port: 5432,
            protocol: "tcp",
            address: "127.0.0.1",
            process_name: "postgres"
          },
          {
            service_id: null,
            pid: 10_201,
            port: 5432,
            protocol: "tcp",
            address: "0.0.0.0",
            process_name: "postgres-copy"
          }
        ]),
  refreshPorts: () =>
    isTauriRuntime()
      ? invoke<PortRefreshResultDto>("refresh_ports")
      : Promise.resolve({
          refreshed_count: 1,
          duration_ms: 2,
          refreshed_at: now()
        })
};

export function formatTauriError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "detail" in error) {
    return JSON.stringify((error as { detail: unknown }).detail);
  }
  return error instanceof Error ? error.message : "Unknown error";
}

function demoResourceMetrics(minutes: number): ResourceMetricPointDto[] {
  const count = minutes <= 15 ? 46 : minutes <= 60 ? 61 : 73;
  const end = Date.now();
  const profiles = [
    {
      id: "demo-elasticsearch",
      cpu: 21,
      memory: 2.1 * 1024 ** 3,
      phase: 0.2,
      growth: 0.36 * 1024 ** 3
    },
    {
      id: "demo-postgres",
      cpu: 12,
      memory: 0.74 * 1024 ** 3,
      phase: 1.1,
      growth: 0.07 * 1024 ** 3
    },
    { id: "demo-redis", cpu: 7.5, memory: 0.31 * 1024 ** 3, phase: 2.2, growth: 0.04 * 1024 ** 3 },
    { id: "demo-minio", cpu: 2.5, memory: 0.13 * 1024 ** 3, phase: 2.8, growth: 0.02 * 1024 ** 3 }
  ];
  return profiles.flatMap((profile) =>
    Array.from({ length: count }, (_, index) => {
      const progress = index / (count - 1);
      const wave = Math.sin(index * 0.55 + profile.phase);
      return {
        service_id: profile.id,
        cpu_percent: Math.max(0, profile.cpu + wave * 2.2 + Math.sin(index * 0.19) * 1.1),
        memory_bytes: Math.round(
          profile.memory + profile.growth * progress + wave * 16 * 1024 ** 2
        ),
        captured_at: new Date(end - (1 - progress) * minutes * 60_000).toISOString()
      };
    })
  );
}

function demoActivityHistory(): OperationHistoryDto[] {
  const base = new Date();
  const at = (daysAgo: number, hour: number, minute: number, second: number) => {
    const date = new Date(base);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, minute, second, 0);
    return date.toISOString();
  };
  const rows = [
    ["elasticsearch-full", "stop", 0, 15, 42, 18, 2340],
    ["redis", "stop", 1, 15, 41, 2, 5210],
    ["minio", "start", 0, 15, 38, 47, 3120],
    ["elasticsearch-full", "start", 0, 15, 36, 33, 4180],
    ["redis", "start", 0, 15, 34, 10, 2750],
    ["elasticsearch-full", "stop", 0, 15, 32, 5, 2280],
    ["minio", "stop", 0, 15, 31, 11, 1640],
    ["redis", "start", 0, 22, 18, 43, 2630, 1],
    ["minio", "start", 0, 22, 16, 29, 3010, 1],
    ["elasticsearch-full", "start", 1, 22, 14, 12, 5870, 1],
    ["elasticsearch-full", "stop", 0, 21, 58, 7, 2190, 1],
    ["redis", "stop", 0, 21, 55, 33, 1830, 1]
  ] as const;

  return rows.map(
    ([service, type, exitCode, hour, minute, second, duration, daysAgo = 0], index) => {
      const startedAt = at(daysAgo, hour, minute, second);
      const failed = exitCode !== 0;
      return {
        id: `demo-activity-${index}`,
        service_id: `demo-${service}`,
        provider: "homebrew",
        operation_type: type,
        command: ["brew", "services", type, service],
        exit_code: exitCode,
        stdout_summary: failed
          ? `Stopping \`${service}\` ... (might take a while)`
          : `==> Successfully ${type === "start" ? "started" : "stopped"} \`${service}\``,
        stderr_summary: failed
          ? `Error: Failure while executing /usr/local/bin/brew services ${type} ${service}`
          : "",
        error_message: failed
          ? `Command exited with status ${exitCode}. Try running: brew cleanup ${service}`
          : null,
        started_at: startedAt,
        finished_at: new Date(new Date(startedAt).getTime() + duration).toISOString(),
        duration_ms: duration
      };
    }
  );
}

function demoDetail(serviceId: string): ServiceDetailDto {
  const summary = demoServices.find((service) => service.id === serviceId) ?? demoServices[0];
  const historyBaseTime = Date.now();
  const dateAt = (daysAgo: number, hour: number, minute: number) => {
    const date = new Date(historyBaseTime);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  };
  const history = [
    {
      type: "stop",
      startedAt: new Date(historyBaseTime - 8 * 60_000).toISOString(),
      durationMs: 840,
      output: `${summary.service_name} stopped`
    },
    {
      type: "start",
      startedAt: new Date(historyBaseTime - 42 * 60_000).toISOString(),
      durationMs: 1_260,
      output: `${summary.service_name} started`
    },
    {
      type: "stop",
      startedAt: dateAt(1, 16, 6),
      durationMs: 760,
      output: `${summary.service_name} stopped`
    },
    {
      type: "start",
      startedAt: dateAt(2, 9, 24),
      durationMs: 1_180,
      output: `${summary.service_name} started`
    },
    {
      type: "stop",
      startedAt: dateAt(3, 15, 22),
      durationMs: 910,
      output: `${summary.service_name} stopped`
    }
  ].map(({ type, startedAt, durationMs, output }, index): OperationHistoryDto => {
    return {
      id: `demo-history-${index}`,
      service_id: summary.id,
      provider: summary.provider,
      operation_type: type,
      command: ["brew", "services", type, summary.service_name],
      exit_code: 0,
      stdout_summary: output,
      stderr_summary: "",
      error_message: null,
      started_at: startedAt,
      finished_at: new Date(new Date(startedAt).getTime() + durationMs).toISOString(),
      duration_ms: durationMs
    };
  });
  return {
    service: {
      id: summary.id,
      provider: summary.provider,
      service_name: summary.service_name,
      formula: summary.formula,
      status: summary.status,
      user: summary.user,
      plist_path: `/Users/local/Library/LaunchAgents/homebrew.mxcl.${summary.formula}.plist`,
      file_path: `/Users/local/Library/LaunchAgents/homebrew.mxcl.${summary.formula}.plist`,
      favorite: false,
      note: null,
      provider_metadata: { preview: true },
      updated_at: summary.updated_at
    },
    latest_snapshot: {
      service_id: summary.id,
      status: summary.status,
      pid: summary.pid,
      cpu_percent: summary.cpu_percent,
      memory_bytes: summary.memory_bytes,
      uptime_seconds: 3600,
      error_message: null,
      captured_at: now()
    },
    ports: summary.ports.map((port) => ({
      service_id: summary.id,
      pid: summary.pid ?? 0,
      port,
      protocol: "tcp",
      address: "127.0.0.1",
      process_name: summary.formula.split("@")[0]
    })),
    log_sources: [],
    history,
    command_preview: ["brew", "services", "restart", summary.service_name]
  };
}

function demoOperation(serviceId: string, operationType: string): Promise<OperationResultDto> {
  const service = demoServices.find((item) => item.id === serviceId) ?? demoServices[0];
  return Promise.resolve({
    operation: {
      id: `demo-${operationType}-${Date.now()}`,
      service_id: serviceId,
      provider: "homebrew",
      operation_type: operationType,
      command: ["brew", "services", operationType, service.service_name],
      exit_code: 0,
      stdout_summary: "Preview operation completed.",
      stderr_summary: "",
      error_message: null,
      started_at: now(),
      finished_at: now(),
      duration_ms: 10
    },
    command: ["brew", "services", operationType, service.service_name],
    success: true,
    refresh: { discovered_count: demoServices.length, duration_ms: 10, refreshed_at: now() }
  });
}
