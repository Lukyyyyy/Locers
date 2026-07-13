import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Copy,
  Database,
  Loader2,
  Play,
  PlugZap,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  Square,
  TerminalSquare,
  ChevronDown,
  CopyCheck,
  Gauge,
  HardDrive,
  Info,
  PackagePlus,
  Trash2
} from "lucide-react";
import { api, formatTauriError } from "../api/client";
import type {
  OperationHistoryDto,
  ResourceMetricPointDto,
  ServiceSummaryDto,
  ServiceStatus
} from "../api/types";
import { useUiStore } from "../state/uiStore";
import {
  formatBytes,
  formatDuration,
  getDisplayUptimeSeconds,
  formatPercent,
  formatPorts
} from "./format";
import { statusLabel, useI18n } from "./i18n";
import { StatusPill } from "./status";

const UPTIME_TICK_INTERVAL_MS = 1_000;
const RECENT_ACTIVITY_DAY_COUNT = 3;

export function App() {
  const nav = useUiStore((state) => state.nav);
  const setNav = useUiStore((state) => state.setNav);
  const { t } = useI18n();

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <TerminalSquare size={19} />
          </div>
          <div>
            <strong>Locers</strong>
            <span>{t("brandSubtitle")}</span>
          </div>
        </div>
        <nav className="nav">
          <button className={nav === "services" ? "active" : ""} onClick={() => setNav("services")}>
            <Database size={16} /> {t("services")}
          </button>
          <button className={nav === "install" ? "active" : ""} onClick={() => setNav("install")}>
            <PackagePlus size={16} /> {t("install")}
          </button>
          <button className={nav === "ports" ? "active" : ""} onClick={() => setNav("ports")}>
            <PlugZap size={16} /> {t("ports")}
          </button>
          <button className={nav === "activity" ? "active" : ""} onClick={() => setNav("activity")}>
            <Activity size={16} /> {t("activity")}
          </button>
          <button className={nav === "settings" ? "active" : ""} onClick={() => setNav("settings")}>
            <Settings size={16} /> {t("settings")}
          </button>
        </nav>
      </aside>

      <section className="workspace">
        {nav === "services" && <ServicesView />}
        {nav === "install" && <InstallView />}
        {nav === "ports" && <PortsView />}
        {nav === "activity" && <ActivityView />}
        {nav === "settings" && <SettingsView />}
      </section>
    </main>
  );
}

const INSTALL_CATALOG = [
  {
    formula: "postgresql@16",
    name: "PostgreSQL 16",
    description: ["Relational database", "关系型数据库"],
    port: 5432
  },
  {
    formula: "mysql",
    name: "MySQL",
    description: ["Relational database", "关系型数据库"],
    port: 3306
  },
  { formula: "redis", name: "Redis", description: ["In-memory cache", "内存缓存"], port: 6379 },
  {
    formula: "rabbitmq",
    name: "RabbitMQ",
    description: ["Message broker", "消息队列"],
    port: 5672
  },
  { formula: "kafka", name: "Kafka", description: ["Event streaming", "事件流服务"], port: 9092 },
  {
    formula: "nginx",
    name: "Nginx",
    description: ["Web server and proxy", "Web 服务器与代理"],
    port: 8080
  },
  {
    formula: "caddy",
    name: "Caddy",
    description: ["Web server with automatic HTTPS", "自动 HTTPS Web 服务器"],
    port: 80
  },
  {
    formula: "memcached",
    name: "Memcached",
    description: ["Distributed memory cache", "分布式内存缓存"],
    port: 11211
  },
  {
    formula: "meilisearch",
    name: "Meilisearch",
    description: ["Search engine", "搜索引擎"],
    port: 7700
  },
  {
    formula: "minio",
    name: "MinIO",
    description: ["S3-compatible object storage", "兼容 S3 的对象存储"],
    port: 9000
  }
] as const;

function InstallView() {
  const queryClient = useQueryClient();
  const { t, language } = useI18n();
  const [search, setSearch] = useState("");
  const [installFilter, setInstallFilter] = useState<"all" | "installed" | "updates">("all");
  const [confirmFormula, setConfirmFormula] = useState<string | null>(null);
  const [upgradeFormula, setUpgradeFormula] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusesQuery = useQuery({
    queryKey: ["formula-statuses"],
    queryFn: api.getFormulaStatuses
  });
  const statusByFormula = new Map((statusesQuery.data ?? []).map((item) => [item.formula, item]));
  const statusesLoaded = statusesQuery.data !== undefined;
  const installedCount = INSTALL_CATALOG.filter(
    (item) => statusByFormula.get(item.formula)?.installed
  ).length;
  const updatesCount = INSTALL_CATALOG.filter(
    (item) => statusByFormula.get(item.formula)?.outdated
  ).length;
  const filtered = INSTALL_CATALOG.filter((item) => {
    const status = statusByFormula.get(item.formula);
    const matchesFilter =
      installFilter === "all" ||
      (installFilter === "installed" && status?.installed === true) ||
      (installFilter === "updates" && status?.outdated === true);
    const matchesSearch = `${item.name} ${item.formula} ${item.description.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });
  const selected = INSTALL_CATALOG.find((item) => item.formula === confirmFormula);
  const selectedUpgrade = INSTALL_CATALOG.find((item) => item.formula === upgradeFormula);

  const installMutation = useMutation({
    mutationFn: api.installFormula,
    onSuccess: (result) => {
      const item = INSTALL_CATALOG.find((entry) => entry.formula === result.formula);
      setConfirmFormula(null);
      setError(null);
      setNotice(t("installSuccess").replace("{name}", item?.name ?? result.formula));
      queryClient.invalidateQueries({ queryKey: ["formula-statuses"] });
      queryClient.invalidateQueries({ queryKey: ["services"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err) => {
      setConfirmFormula(null);
      setError(formatTauriError(err));
    }
  });

  const upgradeMutation = useMutation({
    mutationFn: api.upgradeFormula,
    onSuccess: (result) => {
      const item = INSTALL_CATALOG.find((entry) => entry.formula === result.formula);
      setUpgradeFormula(null);
      setError(null);
      setNotice(t("updateSuccess").replace("{name}", item?.name ?? result.formula));
      queryClient.invalidateQueries({ queryKey: ["formula-statuses"] });
      queryClient.invalidateQueries({ queryKey: ["services"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err) => {
      setUpgradeFormula(null);
      setError(formatTauriError(err));
    }
  });

  return (
    <div className="single-pane install-pane">
      <div className="toolbar">
        <div>
          <h1>{t("install")}</h1>
        </div>
      </div>
      <label className="search-box install-search">
        <Search size={16} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchInstallServices")}
        />
      </label>
      <div className="install-filter" role="tablist" aria-label={t("installServices")}>
        <button
          type="button"
          role="tab"
          aria-selected={installFilter === "all"}
          className={installFilter === "all" ? "active" : ""}
          onClick={() => setInstallFilter("all")}
        >
          {t("allInstallServices")} <span>{INSTALL_CATALOG.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={installFilter === "updates"}
          className={installFilter === "updates" ? "active" : ""}
          disabled={!statusesLoaded}
          onClick={() => setInstallFilter("updates")}
        >
          {t("updatesAvailable")} <span>{statusesLoaded ? updatesCount : "…"}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={installFilter === "installed"}
          className={installFilter === "installed" ? "active" : ""}
          disabled={!statusesLoaded}
          onClick={() => setInstallFilter("installed")}
        >
          {t("installed")} <span>{statusesLoaded ? installedCount : "…"}</span>
        </button>
      </div>
      {notice && (
        <div className="install-notice">
          <Check size={16} /> {notice}
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
      <div className="install-grid">
        {filtered.map((item) => {
          const status = statusByFormula.get(item.formula);
          const installed = status?.installed ?? false;
          const pending = installMutation.isPending && installMutation.variables === item.formula;
          const upgradePending =
            upgradeMutation.isPending && upgradeMutation.variables === item.formula;
          return (
            <article className="install-card" key={item.formula}>
              <div className="install-card-icon">
                <PackagePlus size={19} />
              </div>
              <div className="install-card-copy">
                <h2>{item.name}</h2>
                <p>{item.description[language === "zh" ? 1 : 0]}</p>
                <div className="install-meta">
                  <code>{item.formula}</code>
                  <span>
                    {t("defaultPort")} {item.port}
                  </span>
                </div>
              </div>
              <div className="install-card-action">
                {installFilter === "updates" && status?.outdated ? (
                  <div className="update-action">
                    <span className="update-version">
                      {status.version ?? "?"} <span aria-hidden="true">→</span>{" "}
                      {status.current_version ?? "?"}
                    </span>
                    <button
                      className="primary-button"
                      disabled={upgradePending}
                      onClick={() => setUpgradeFormula(item.formula)}
                    >
                      {upgradePending ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <ArrowUpCircle size={15} />
                      )}
                      {upgradePending ? t("updating") : t("updateAction")}
                    </button>
                  </div>
                ) : installed ? (
                  <span className="installed-label">
                    <Check size={14} />
                    {t("installed")}
                    {status?.version ? ` ${status.version}` : ""}
                  </span>
                ) : (
                  <button
                    className="primary-button"
                    disabled={pending || statusesQuery.isLoading}
                    onClick={() => setConfirmFormula(item.formula)}
                  >
                    {pending ? <Loader2 className="spin" size={15} /> : <PackagePlus size={15} />}
                    {pending ? t("installing") : t("installAction")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {filtered.length === 0 && installFilter === "installed" && (
        <div className="empty-state">{t("noInstalledServices")}</div>
      )}
      {filtered.length === 0 && installFilter === "updates" && (
        <div className="empty-state">{t("noUpdatesAvailable")}</div>
      )}
      {selected && (
        <div
          className="dialog-backdrop"
          onMouseDown={() => !installMutation.isPending && setConfirmFormula(null)}
        >
          <section
            className="confirm-dialog install-dialog"
            role="alertdialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-content">
              <h2>{t("installConfirmTitle").replace("{name}", selected.name)}</h2>
              <p>{t("installConfirmDescription")}</p>
              <code className="delete-command">brew install --formula {selected.formula}</code>
              <div className="dialog-actions">
                <button
                  disabled={installMutation.isPending}
                  onClick={() => setConfirmFormula(null)}
                >
                  {t("cancel")}
                </button>
                <button
                  className="primary-button"
                  disabled={installMutation.isPending}
                  onClick={() => installMutation.mutate(selected.formula)}
                >
                  {installMutation.isPending ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <PackagePlus size={15} />
                  )}
                  {installMutation.isPending ? t("installing") : t("installAction")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {selectedUpgrade && (
        <div
          className="dialog-backdrop"
          onMouseDown={() => !upgradeMutation.isPending && setUpgradeFormula(null)}
        >
          <section
            className="confirm-dialog install-dialog"
            role="alertdialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-content">
              <h2>{t("updateConfirmTitle").replace("{name}", selectedUpgrade.name)}</h2>
              <p>{t("updateConfirmDescription")}</p>
              <p className="upgrade-version-path">
                {t("updateVersionPath")
                  .replace("{from}", statusByFormula.get(selectedUpgrade.formula)?.version ?? "?")
                  .replace(
                    "{to}",
                    statusByFormula.get(selectedUpgrade.formula)?.current_version ?? "?"
                  )}
              </p>
              <code className="delete-command">
                brew upgrade --formula {selectedUpgrade.formula}
              </code>
              <div className="dialog-actions">
                <button
                  disabled={upgradeMutation.isPending}
                  onClick={() => setUpgradeFormula(null)}
                >
                  {t("cancel")}
                </button>
                <button
                  className="primary-button"
                  disabled={upgradeMutation.isPending}
                  onClick={() => upgradeMutation.mutate(selectedUpgrade.formula)}
                >
                  {upgradeMutation.isPending ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <ArrowUpCircle size={15} />
                  )}
                  {upgradeMutation.isPending ? t("updating") : t("updateAction")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ServicesView() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const selectedServiceId = useUiStore((state) => state.selectedServiceId);
  const setSelectedServiceId = useUiStore((state) => state.setSelectedServiceId);
  const statusFilter = useUiStore((state) => state.statusFilter);
  const setStatusFilter = useUiStore((state) => state.setStatusFilter);
  const search = useUiStore((state) => state.search);
  const setSearch = useUiStore((state) => state.setSearch);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<Record<string, string[]>>({});
  const [pendingServiceIds, setPendingServiceIds] = useState<Set<string>>(() => new Set());
  const [serviceToRemove, setServiceToRemove] = useState<ServiceSummaryDto | null>(null);
  const [uptimeTick, setUptimeTick] = useState(Date.now());
  const [servicesReceivedAt, setServicesReceivedAt] = useState(Date.now());
  const refreshMode = useUiStore((state) => state.refreshMode);
  const reduceRefreshInBackground = useUiStore((state) => state.reduceRefreshInBackground);
  const refreshIntervals = getRefreshIntervals(refreshMode);
  const initialRefreshCompletedRef = useRef(false);
  const fullRefreshPromiseRef = useRef<ReturnType<typeof api.refreshServices> | null>(null);
  const runtimeRefreshPromiseRef = useRef<ReturnType<typeof api.refreshRuntimeMetrics> | null>(
    null
  );

  const servicesQuery = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      if (!initialRefreshCompletedRef.current) {
        initialRefreshCompletedRef.current = true;
        await api.refreshServices();
      }
      return api.getServices();
    }
  });

  const invalidateFullRefreshData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["services"] });
    if (selectedServiceId) {
      queryClient.invalidateQueries({ queryKey: ["service-detail", selectedServiceId] });
    }
    queryClient.invalidateQueries({ queryKey: ["ports"] });
    queryClient.invalidateQueries({ queryKey: ["activity"] });
  }, [queryClient, selectedServiceId]);

  const getOrStartFullRefresh = useCallback(() => {
    if (fullRefreshPromiseRef.current) return fullRefreshPromiseRef.current;
    const request = api.refreshServices();
    fullRefreshPromiseRef.current = request;
    const clearRequest = () => {
      if (fullRefreshPromiseRef.current === request) fullRefreshPromiseRef.current = null;
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }, []);

  const manualRefreshMutation = useMutation({
    mutationFn: async () => {
      return getOrStartFullRefresh();
    },
    onSuccess: () => {
      setError(null);
      invalidateFullRefreshData();
    },
    onError: (err) => setError(formatTauriError(err))
  });

  const refreshRuntimeMetricsSilently = useCallback(() => {
    if (runtimeRefreshPromiseRef.current) return;
    const request = api.refreshRuntimeMetrics();
    runtimeRefreshPromiseRef.current = request;
    void request
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["services"] });
        if (selectedServiceId) {
          queryClient.invalidateQueries({ queryKey: ["service-detail", selectedServiceId] });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (runtimeRefreshPromiseRef.current === request) runtimeRefreshPromiseRef.current = null;
      });
  }, [queryClient, selectedServiceId]);

  const operationMutation = useMutation({
    mutationFn: ({ serviceId, operation }: { serviceId: string; operation: "start" | "stop" }) =>
      operation === "start" ? api.startService(serviceId) : api.stopService(serviceId),
    onMutate: ({ serviceId, operation }) => {
      setOperationError(null);
      setSelectedServiceId(serviceId);
      setPendingServiceIds((current) => new Set(current).add(serviceId));
      if (operation === "start") {
        setSessionLogs((current) => ({ ...current, [serviceId]: [] }));
        queryClient.setQueryData(["service-logs", serviceId], {
          source: null,
          lines: [],
          error: null
        });
      }
    },
    onSuccess: (result, { serviceId, operation }) => {
      const output = [
        `$ ${result.command.join(" ")}`,
        result.operation.stdout_summary,
        result.operation.stderr_summary
      ].filter((line): line is string => Boolean(line));
      setSessionLogs((current) => ({
        ...current,
        [serviceId]: operation === "start" ? output : [...(current[serviceId] ?? []), ...output]
      }));
      queryClient.invalidateQueries({ queryKey: ["services"] });
      queryClient.invalidateQueries({ queryKey: ["service-detail", serviceId] });
      queryClient.invalidateQueries({ queryKey: ["service-logs", serviceId] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err, { serviceId, operation }) => {
      const message = formatTauriError(err);
      setOperationError(message);
      setSessionLogs((current) => ({
        ...current,
        [serviceId]: operation === "start" ? [message] : [...(current[serviceId] ?? []), message]
      }));
      queryClient.invalidateQueries({ queryKey: ["service-detail", serviceId] });
      queryClient.invalidateQueries({ queryKey: ["service-logs", serviceId] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onSettled: (_result, _error, variables) => {
      setPendingServiceIds((current) => {
        const next = new Set(current);
        next.delete(variables.serviceId);
        return next;
      });
    }
  });

  const removeMutation = useMutation({
    mutationFn: ({ serviceId }: { serviceId: string }) => api.removeService(serviceId),
    onMutate: ({ serviceId }) => {
      setOperationError(null);
      setPendingServiceIds((current) => new Set(current).add(serviceId));
    },
    onSuccess: (_result, { serviceId }) => {
      const remaining = (servicesQuery.data ?? []).filter((service) => service.id !== serviceId);
      queryClient.setQueryData<ServiceSummaryDto[]>(["services"], remaining);
      if (selectedServiceId === serviceId) {
        setSelectedServiceId(remaining[0]?.id ?? null);
      }
      setSessionLogs((current) => {
        const next = { ...current };
        delete next[serviceId];
        return next;
      });
      setServiceToRemove(null);
      queryClient.removeQueries({ queryKey: ["service-detail", serviceId] });
      queryClient.removeQueries({ queryKey: ["service-logs", serviceId] });
      queryClient.invalidateQueries({ queryKey: ["ports"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err) => setOperationError(formatTauriError(err)),
    onSettled: (_result, _error, { serviceId }) => {
      setPendingServiceIds((current) => {
        const next = new Set(current);
        next.delete(serviceId);
        return next;
      });
    }
  });

  useEffect(() => {
    if (!selectedServiceId && servicesQuery.data?.[0]) {
      setSelectedServiceId(servicesQuery.data[0].id);
    }
  }, [selectedServiceId, servicesQuery.data, setSelectedServiceId]);

  useEffect(() => {
    if (servicesQuery.data) {
      const now = Date.now();
      setServicesReceivedAt(now);
      setUptimeTick(now);
    }
  }, [servicesQuery.data]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setUptimeTick(Date.now()), UPTIME_TICK_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const refreshSilently = () => {
      const request = getOrStartFullRefresh();
      void request.then(invalidateFullRefreshData).catch(() => undefined);
    };

    const intervalId = window.setInterval(refreshSilently, refreshIntervals.services);
    return () => window.clearInterval(intervalId);
  }, [getOrStartFullRefresh, invalidateFullRefreshData, refreshIntervals.services]);

  useEffect(() => {
    let timeoutId: number | undefined;

    const schedule = () => {
      const delay =
        document.hidden && reduceRefreshInBackground
          ? Math.max(refreshIntervals.runtime, 5_000)
          : refreshIntervals.runtime;
      timeoutId = window.setTimeout(() => {
        refreshRuntimeMetricsSilently();
        schedule();
      }, delay);
    };
    const reschedule = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      refreshRuntimeMetricsSilently();
      schedule();
    };

    refreshRuntimeMetricsSilently();
    schedule();
    document.addEventListener("visibilitychange", reschedule);
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", reschedule);
    };
  }, [reduceRefreshInBackground, refreshIntervals.runtime, refreshRuntimeMetricsSilently]);

  const filteredServices = useMemo(() => {
    const q = search.toLowerCase();
    return (servicesQuery.data ?? []).filter((service) => {
      const matchesStatus = statusFilter === "all" || service.status === statusFilter;
      const matchesSearch =
        !q ||
        service.service_name.toLowerCase().includes(q) ||
        service.formula.toLowerCase().includes(q) ||
        service.provider.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [servicesQuery.data, statusFilter, search]);

  return (
    <div className="content-grid">
      <section className="primary-pane">
        <header className="toolbar">
          <div>
            <h1>{t("services")}</h1>
          </div>
        </header>

        <div className="filters filters-with-refresh">
          <label className="search-box">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchServices")}
            />
          </label>
          <StatusFilterSelect value={statusFilter} onChange={setStatusFilter} />
          <button
            className="primary-button refresh-icon-button"
            aria-label={t("refresh")}
            title={t("refresh")}
            onClick={() => manualRefreshMutation.mutate()}
            disabled={manualRefreshMutation.isPending}
          >
            {manualRefreshMutation.isPending ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <RefreshCcw size={15} />
            )}
          </button>
        </div>

        {error && <InlineError message={error} />}
        {servicesQuery.isLoading && <EmptyState title={t("loadingServices")} />}
        {!servicesQuery.isLoading && filteredServices.length === 0 && (
          <EmptyState title={t("noServicesDiscovered")} />
        )}
        {filteredServices.length > 0 && (
          <ServiceTable
            services={filteredServices}
            uptimeTick={uptimeTick}
            servicesReceivedAt={servicesReceivedAt}
            selectedServiceId={selectedServiceId}
            pendingServiceIds={pendingServiceIds}
            onToggleService={(service) =>
              operationMutation.mutate({
                serviceId: service.id,
                operation: service.status === "running" ? "stop" : "start"
              })
            }
            onRemoveService={setServiceToRemove}
          />
        )}
        {operationError && <InlineError message={operationError} />}
      </section>

      <ServiceInspector
        serviceId={selectedServiceId}
        sessionLogLines={selectedServiceId ? (sessionLogs[selectedServiceId] ?? []) : []}
      />
      {serviceToRemove && (
        <RemoveServiceDialog
          service={serviceToRemove}
          pending={removeMutation.isPending}
          onCancel={() => setServiceToRemove(null)}
          onConfirm={() => removeMutation.mutate({ serviceId: serviceToRemove.id })}
        />
      )}
    </div>
  );
}

type StatusFilterValue = ServiceStatus | "all";

function StatusFilterSelect({
  value,
  onChange
}: {
  value: StatusFilterValue;
  onChange: (value: StatusFilterValue) => void;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<ComponentRef<"div">>(null);
  const options: Array<{ value: StatusFilterValue; label: string }> = [
    { value: "all", label: t("allStatus") },
    { value: "running", label: statusLabel("running", language) },
    { value: "stopped", label: statusLabel("stopped", language) },
    { value: "error", label: statusLabel("error", language) },
    { value: "unknown", label: statusLabel("unknown", language) }
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    const closeOnOutsideClick = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setActiveIndex(index);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        setActiveIndex(
          Math.max(
            0,
            options.findIndex((option) => option.value === value)
          )
        );
        setOpen(true);
      } else {
        setActiveIndex((current) => (current + direction + options.length) % options.length);
      }
      return;
    }
    if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  return (
    <div ref={rootRef} className="status-select">
      <button
        type="button"
        className="status-select-trigger"
        role="combobox"
        aria-label={t("status")}
        aria-expanded={open}
        aria-controls="status-filter-options"
        aria-activedescendant={open ? `status-filter-${options[activeIndex].value}` : undefined}
        onClick={() => {
          setActiveIndex(
            Math.max(
              0,
              options.findIndex((option) => option.value === value)
            )
          );
          setOpen((current) => !current);
        }}
        onKeyDown={onKeyDown}
      >
        <span className={`filter-dot filter-dot-${selected.value}`} aria-hidden="true" />
        <span>{selected.label}</span>
        <ChevronDown className={open ? "open" : ""} size={15} aria-hidden="true" />
      </button>
      {open && (
        <div id="status-filter-options" className="status-select-menu" role="listbox">
          {options.map((option, index) => (
            <button
              id={`status-filter-${option.value}`}
              key={option.value}
              type="button"
              className={index === activeIndex ? "active" : ""}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className={`filter-dot filter-dot-${option.value}`} aria-hidden="true" />
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RemoveServiceDialog({
  service,
  pending,
  onCancel,
  onConfirm
}: {
  service: ServiceSummaryDto;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, pending]);

  return (
    <div className="dialog-backdrop" onMouseDown={() => !pending && onCancel()}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-service-title"
        aria-describedby="remove-service-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-danger-mark">
          <Trash2 size={20} />
        </div>
        <div className="dialog-content">
          <h2 id="remove-service-title">{t("removeServiceTitle")}</h2>
          <p id="remove-service-description">
            <strong>{service.service_name}</strong> — {t("removeServiceDescription")}
          </p>
          <div className="delete-scope">
            <p>{t("removeServiceScope")}</p>
            <p>{t("removeServiceDataNotice")}</p>
          </div>
          <code className="delete-command">brew uninstall --formula {service.formula}</code>
          <div className="dialog-actions">
            <button type="button" disabled={pending} onClick={onCancel}>
              {t("cancel")}
            </button>
            <button type="button" className="danger-button" disabled={pending} onClick={onConfirm}>
              {pending ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
              {pending ? t("removing") : t("confirmRemove")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ServiceTable({
  services,
  uptimeTick,
  servicesReceivedAt,
  selectedServiceId,
  pendingServiceIds,
  onToggleService,
  onRemoveService
}: {
  services: ServiceSummaryDto[];
  uptimeTick: number;
  servicesReceivedAt: number;
  selectedServiceId: string | null;
  pendingServiceIds: Set<string>;
  onToggleService: (service: ServiceSummaryDto) => void;
  onRemoveService: (service: ServiceSummaryDto) => void;
}) {
  const setSelectedServiceId = useUiStore((state) => state.setSelectedServiceId);
  const { t, language } = useI18n();
  return (
    <div className="table-wrap">
      <table className="service-table">
        <thead>
          <tr>
            <th>{t("service")}</th>
            <th>{t("status")}</th>
            <th>{t("uptime")}</th>
            <th aria-label={t("operation")} />
          </tr>
        </thead>
        <tbody>
          {services.map((service) => {
            const isRunning = service.status === "running";
            const isPending = pendingServiceIds.has(service.id);
            const label = isRunning ? t("stop") : t("start");
            const displayedUptime = getDisplayUptimeSeconds({
              status: service.status,
              uptimeSeconds: service.uptime_seconds,
              receivedAt: servicesReceivedAt,
              now: uptimeTick
            });
            return (
              <tr
                key={service.id}
                className={selectedServiceId === service.id ? "selected" : ""}
                onClick={() => setSelectedServiceId(service.id)}
              >
                <td>
                  <strong>{service.service_name}</strong>
                  <span>{service.provider}</span>
                </td>
                <td>
                  <StatusPill status={service.status} />
                </td>
                <td>{formatDuration(displayedUptime, language)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={label}
                      title={label}
                      disabled={isPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleService(service);
                      }}
                    >
                      {isPending ? (
                        <Loader2 className="spin" size={15} />
                      ) : isRunning ? (
                        <Square size={15} />
                      ) : (
                        <Play size={15} />
                      )}
                    </button>
                    <button
                      className="icon-button danger-icon-button"
                      type="button"
                      aria-label={`${t("remove")}: ${service.service_name}`}
                      title={t("remove")}
                      disabled={isPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveService(service);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ServiceInspector({
  serviceId,
  sessionLogLines
}: {
  serviceId: string | null;
  sessionLogLines: string[];
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"status" | "logs" | "activity">("status");
  const [logsCopied, setLogsCopied] = useState(false);
  const inspectorRef = useRef<ComponentRef<"aside">>(null);
  const logViewRef = useRef<ComponentRef<"pre">>(null);
  const isFollowingLogsRef = useRef(true);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);

  const detailQuery = useQuery({
    queryKey: ["service-detail", serviceId],
    queryFn: () => api.getServiceDetail(serviceId as string),
    enabled: Boolean(serviceId)
  });

  const logsQuery = useQuery({
    queryKey: ["service-logs", serviceId],
    queryFn: () => api.getServiceLogs(serviceId as string, 2000),
    enabled: Boolean(serviceId) && activeTab === "logs",
    refetchInterval: activeTab === "logs" ? 1_500 : false
  });

  const logText = buildServiceLogLines(
    sessionLogLines,
    logsQuery.data?.lines ?? [],
    logsQuery.data?.error
  ).join("\n");

  useEffect(() => {
    if (activeTab !== "logs" || !logViewRef.current) return;
    isFollowingLogsRef.current = true;
    logViewRef.current.scrollTop = logViewRef.current.scrollHeight;
  }, [activeTab, serviceId]);

  useEffect(() => {
    if (activeTab !== "logs" || !logViewRef.current || !isFollowingLogsRef.current) return;
    logViewRef.current.scrollTop = logViewRef.current.scrollHeight;
  }, [activeTab, logText]);

  useEffect(() => {
    setLogsCopied(false);
  }, [logText]);

  useEffect(
    () => () => {
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const keepPanelInView = () => {
      if (inspectorRef.current) {
        inspectorRef.current.scrollTop = 0;
        inspectorRef.current.scrollLeft = 0;
      }
      if (activeTab === "logs" && logViewRef.current && isFollowingLogsRef.current) {
        logViewRef.current.scrollTop = logViewRef.current.scrollHeight;
        logViewRef.current.scrollLeft = 0;
      }
    };

    keepPanelInView();
    window.addEventListener("resize", keepPanelInView);
    return () => window.removeEventListener("resize", keepPanelInView);
  }, [activeTab, serviceId]);

  if (!serviceId) {
    return (
      <aside className="inspector">
        <EmptyState title={t("selectService")} />
      </aside>
    );
  }
  if (detailQuery.isLoading) {
    return (
      <aside className="inspector">
        <EmptyState title={t("loadingDetail")} />
      </aside>
    );
  }
  if (detailQuery.error || !detailQuery.data) {
    return (
      <aside className="inspector">
        <InlineError message={formatTauriError(detailQuery.error)} />
      </aside>
    );
  }

  const detail = detailQuery.data;
  const service = detail.service;

  const handleLogScroll = () => {
    const logView = logViewRef.current;
    if (!logView) return;
    const distanceFromBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight;
    isFollowingLogsRef.current = distanceFromBottom <= 16;
  };

  const copyLogs = async () => {
    const copied = await copyTextToClipboard(logText);
    if (!copied) return;
    setLogsCopied(true);
    if (copyFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = window.setTimeout(() => setLogsCopied(false), 1_500);
  };

  return (
    <aside ref={inspectorRef} className="inspector">
      <div className="inspector-head">
        <div>
          <h2>{service.service_name}</h2>
          <span>{service.provider}</span>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label={t("serviceDetailTabs")}>
        <button
          className={activeTab === "status" ? "active" : ""}
          role="tab"
          aria-selected={activeTab === "status"}
          onClick={() => setActiveTab("status")}
        >
          {t("status")}
        </button>
        <button
          className={activeTab === "logs" ? "active" : ""}
          role="tab"
          aria-selected={activeTab === "logs"}
          onClick={() => setActiveTab("logs")}
        >
          {t("logs")}
        </button>
        <button
          className={activeTab === "activity" ? "active" : ""}
          role="tab"
          aria-selected={activeTab === "activity"}
          onClick={() => setActiveTab("activity")}
        >
          {t("recentActivity")}
        </button>
      </div>

      {activeTab === "status" ? (
        <>
          <InfoSection title={t("runtime")}>
            <InfoRow label={t("pid")} value={detail.latest_snapshot?.pid ?? "-"} />
            <InfoRow label={t("cpu")} value={formatPercent(detail.latest_snapshot?.cpu_percent)} />
            <InfoRow
              label={t("memory")}
              value={formatBytes(detail.latest_snapshot?.memory_bytes)}
            />
            <InfoRow
              label={t("ports")}
              value={formatPorts(detail.ports.map((port) => port.port))}
            />
          </InfoSection>

          <InfoSection title={t("homebrew")}>
            <InfoRow label={t("user")} value={service.user ?? "-"} />
            <InfoRow label={t("plist")} value={service.plist_path ?? "-"} />
            <InfoRow label={t("file")} value={service.file_path ?? "-"} />
          </InfoSection>
        </>
      ) : activeTab === "logs" ? (
        <div className="log-view-shell">
          <pre
            ref={logViewRef}
            className="log-view session-log"
            aria-label={t("logs")}
            tabIndex={0}
            onScroll={handleLogScroll}
          >
            {logText}
          </pre>
          <button
            type="button"
            className="log-copy-button"
            aria-label={logsCopied ? t("logsCopied") : t("copyLogs")}
            title={logsCopied ? t("logsCopied") : t("copyLogs")}
            disabled={!logText}
            onClick={() => void copyLogs()}
          >
            {logsCopied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      ) : (
        <RecentActivityTimeline operations={detail.history} />
      )}
    </aside>
  );
}

function buildServiceLogLines(
  operationLines: string[],
  serviceLines: string[],
  logError?: string | null
): string[] {
  const separator = operationLines.length && serviceLines.length ? [""] : [];
  const errorLines = !serviceLines.length && logError ? [logError] : [];
  return [...operationLines, ...separator, ...serviceLines, ...errorLines];
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await globalThis.navigator.clipboard?.writeText(text);
    if (globalThis.navigator.clipboard) return true;
  } catch {
    // Some WebViews expose the Clipboard API but reject it. Fall through to
    // the selection-based copy path supported by older WebKit versions.
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  textArea.style.pointerEvents = "none";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textArea.remove();
  }
}

function PortsView() {
  const { t, language } = useI18n();
  const [search, setSearch] = useState("");
  const portsTableRef = useRef<HTMLDivElement>(null);
  const portsScrollbarDragOffsetRef = useRef<number | null>(null);
  const [portsScrollbar, setPortsScrollbar] = useState({ top: 0, height: 0, visible: false });
  const refreshMode = useUiStore((state) => state.refreshMode);
  const servicesQuery = useQuery({ queryKey: ["services"], queryFn: api.getServices });
  const portsQuery = useQuery({
    queryKey: ["ports"],
    queryFn: async () => {
      await api.refreshPorts();
      return api.getPorts();
    },
    refetchInterval: getRefreshIntervals(refreshMode).ports,
    refetchIntervalInBackground: false
  });
  const serviceNames = useMemo(
    () => new Map((servicesQuery.data ?? []).map((service) => [service.id, service.service_name])),
    [servicesQuery.data]
  );
  const filteredPorts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return portsQuery.data ?? [];
    return (portsQuery.data ?? []).filter((port) => {
      const serviceName = port.service_id ? (serviceNames.get(port.service_id) ?? "") : "";
      return [port.port, port.process_name, port.pid, serviceName].some((value) =>
        String(value).toLowerCase().includes(query)
      );
    });
  }, [portsQuery.data, search, serviceNames]);
  const manualRefreshMutation = useMutation({
    mutationFn: () => portsQuery.refetch()
  });
  const lastUpdated = portsQuery.dataUpdatedAt
    ? new Date(portsQuery.dataUpdatedAt).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US")
    : null;
  const syncPortsScrollbar = useCallback(() => {
    const table = portsTableRef.current;
    if (!table) return;
    const { clientHeight, scrollHeight, scrollTop } = table;
    const visible = scrollHeight > clientHeight + 1;
    const height = visible ? Math.max(40, (clientHeight * clientHeight) / scrollHeight) : 0;
    const top = visible
      ? (scrollTop / Math.max(scrollHeight - clientHeight, 1)) * (clientHeight - height)
      : 0;
    setPortsScrollbar({ top, height, visible });
  }, []);
  const setPortsScrollFromPointer = useCallback(
    (event: PointerEvent<HTMLSpanElement>, dragOffset: number) => {
      const table = portsTableRef.current;
      if (!table) return;
      const track = event.currentTarget.getBoundingClientRect();
      const maxThumbTop = Math.max(track.height - portsScrollbar.height, 1);
      const thumbTop = Math.min(maxThumbTop, Math.max(0, event.clientY - track.top - dragOffset));
      table.scrollTop =
        (thumbTop / maxThumbTop) * Math.max(table.scrollHeight - table.clientHeight, 0);
      syncPortsScrollbar();
    },
    [portsScrollbar.height, syncPortsScrollbar]
  );
  const handlePortsScrollbarPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      const target = event.target as HTMLElement;
      const track = event.currentTarget.getBoundingClientRect();
      const dragOffset = target.classList.contains("ports-scrollbar-thumb")
        ? event.clientY - track.top - portsScrollbar.top
        : portsScrollbar.height / 2;
      portsScrollbarDragOffsetRef.current = dragOffset;
      event.currentTarget.setPointerCapture(event.pointerId);
      setPortsScrollFromPointer(event, dragOffset);
    },
    [portsScrollbar.height, portsScrollbar.top, setPortsScrollFromPointer]
  );
  const handlePortsScrollbarPointerMove = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const dragOffset = portsScrollbarDragOffsetRef.current;
      if (dragOffset == null) return;
      setPortsScrollFromPointer(event, dragOffset);
    },
    [setPortsScrollFromPointer]
  );
  const handlePortsScrollbarPointerEnd = useCallback((event: PointerEvent<HTMLSpanElement>) => {
    portsScrollbarDragOffsetRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  useEffect(() => {
    syncPortsScrollbar();
    const table = portsTableRef.current;
    if (!table || typeof ResizeObserver === "undefined") return;
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const multiplier =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? table.clientHeight : 1;
      const previousScrollTop = table.scrollTop;
      table.scrollTop += event.deltaY * multiplier;
      if (table.scrollTop !== previousScrollTop) {
        event.preventDefault();
        syncPortsScrollbar();
      }
    };
    table.addEventListener("wheel", handleWheel, { passive: false });
    const observer = new ResizeObserver(syncPortsScrollbar);
    observer.observe(table);
    const tableBody = table.querySelector("tbody");
    if (tableBody) observer.observe(tableBody);
    return () => {
      table.removeEventListener("wheel", handleWheel);
      observer.disconnect();
    };
  }, [filteredPorts, syncPortsScrollbar]);
  return (
    <section className="single-pane ports-pane">
      <header className="toolbar">
        <div>
          <h1>{t("ports")}</h1>
          <p className="ports-refresh-status" aria-live="polite">
            {t("lastUpdated")} {lastUpdated ?? "-"}
          </p>
        </div>
      </header>
      <div className="filters ports-filters filters-with-refresh">
        <label className="search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPorts")}
          />
        </label>
        <button
          className="primary-button refresh-icon-button"
          aria-label={t("refresh")}
          title={t("refresh")}
          onClick={() => manualRefreshMutation.mutate()}
          disabled={manualRefreshMutation.isPending}
        >
          {manualRefreshMutation.isPending ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <RefreshCcw size={15} />
          )}
        </button>
      </div>
      {portsQuery.error && <InlineError message={formatTauriError(portsQuery.error)} />}
      {portsQuery.isLoading && <EmptyState title={t("refreshing")} />}
      {!portsQuery.isLoading && filteredPorts.length === 0 ? (
        <EmptyState title={t("noMatchingPorts")} />
      ) : (
        <div className="table-wrap ports-table-frame">
          <div ref={portsTableRef} className="ports-table-wrap" onScroll={syncPortsScrollbar}>
            <table className="service-table ports-table">
              <thead>
                <tr>
                  <th>{t("ports")}</th>
                  <th>{t("process")}</th>
                  <th>{t("pid")}</th>
                  <th>{t("address")}</th>
                  <th>{t("service")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredPorts.map((port) => (
                  <tr key={`${port.pid}-${port.port}-${port.address}`}>
                    <td>{port.port}</td>
                    <td>{port.process_name}</td>
                    <td>{port.pid}</td>
                    <td>{port.address}</td>
                    <td title={port.service_id ?? undefined}>
                      {port.service_id
                        ? (serviceNames.get(port.service_id) ?? port.process_name)
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {portsScrollbar.visible ? (
            <span
              className="ports-scrollbar"
              aria-hidden="true"
              onPointerDown={handlePortsScrollbarPointerDown}
              onPointerMove={handlePortsScrollbarPointerMove}
              onPointerUp={handlePortsScrollbarPointerEnd}
              onPointerCancel={handlePortsScrollbarPointerEnd}
            >
              <span
                className="ports-scrollbar-thumb"
                style={{
                  height: portsScrollbar.height,
                  transform: `translateY(${portsScrollbar.top}px)`
                }}
              />
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ActivityView() {
  const { t, language } = useI18n();
  const [chartMetric, setChartMetric] = useState<"cpu" | "memory">("cpu");
  const [rankingMetric, setRankingMetric] = useState<"cpu" | "memory">("cpu");
  const labels = getMonitoringLabels(language);
  const servicesQuery = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      await api.refreshRuntimeMetrics();
      return api.getServices();
    },
    refetchInterval: 1_000
  });
  const metricsQuery = useQuery({
    queryKey: ["resource-metrics"],
    queryFn: () => api.getSystemResourceMetrics(MONITOR_CHART_WINDOW_MINUTES),
    refetchInterval: 1_000
  });
  const services = useMemo(() => servicesQuery.data ?? [], [servicesQuery.data]);
  const metrics = useMemo(
    () => (Array.isArray(metricsQuery.data) ? metricsQuery.data : []),
    [metricsQuery.data]
  );
  const runningServices = services.filter((service) => service.status === "running");
  const latestSystemMetric = metrics[metrics.length - 1];
  const totalCpu = latestSystemMetric?.cpu_percent ?? 0;
  const totalMemory = latestSystemMetric?.memory_bytes ?? 0;
  const rankedServices = [...runningServices].sort((left, right) => {
    const leftValue = rankingMetric === "cpu" ? (left.cpu_percent ?? 0) : (left.memory_bytes ?? 0);
    const rightValue =
      rankingMetric === "cpu" ? (right.cpu_percent ?? 0) : (right.memory_bytes ?? 0);
    return rightValue - leftValue;
  });
  const visibleRankedServices = rankedServices.slice(0, 3);
  const rankingMax = Math.max(
    ...visibleRankedServices.map((service) =>
      rankingMetric === "cpu" ? (service.cpu_percent ?? 0) : (service.memory_bytes ?? 0)
    ),
    1
  );
  return (
    <section className="monitor-page">
      <header className="monitor-header">
        <h1>{t("activity")}</h1>
      </header>

      <div className="monitor-summary" aria-label={labels.summary}>
        <MonitorMetric label={labels.running} value={runningServices.length} tone="success" />
        <MonitorMetric label="CPU" value={`${totalCpu.toFixed(1)}%`} tone="primary" />
        <MonitorMetric label={labels.memory} value={formatBytes(totalMemory)} tone="purple" />
      </div>

      {servicesQuery.error || metricsQuery.error ? (
        <InlineError message={formatTauriError(servicesQuery.error ?? metricsQuery.error)} />
      ) : null}

      <div className="monitor-chart-workspace">
        <div className="monitor-chart-tabs" role="tablist" aria-label={labels.resourceTrend}>
          <button
            role="tab"
            aria-selected={chartMetric === "cpu"}
            className={chartMetric === "cpu" ? "active" : ""}
            onClick={() => setChartMetric("cpu")}
          >
            CPU
          </button>
          <button
            role="tab"
            aria-selected={chartMetric === "memory"}
            className={chartMetric === "memory" ? "active" : ""}
            onClick={() => setChartMetric("memory")}
          >
            {labels.memory}
          </button>
        </div>
        <ResourceChart
          title={chartMetric === "cpu" ? labels.cpuUsage : labels.memoryUsage}
          metric={chartMetric}
          points={metrics}
          language={language}
          emptyMessage={servicesQuery.isLoading ? labels.loadingTrends : labels.waitingForTrendData}
        />
      </div>

      <div className="monitor-lower">
        <section className="monitor-panel resource-ranking">
          <header className="monitor-panel-header">
            <h2>{labels.resourceRanking}</h2>
            <div className="ranking-metric-tabs" role="tablist" aria-label={labels.rankingMetric}>
              <button
                type="button"
                role="tab"
                aria-selected={rankingMetric === "cpu"}
                className={rankingMetric === "cpu" ? "active" : ""}
                onClick={() => setRankingMetric("cpu")}
              >
                CPU
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rankingMetric === "memory"}
                className={rankingMetric === "memory" ? "active" : ""}
                onClick={() => setRankingMetric("memory")}
              >
                {labels.memory}
              </button>
            </div>
          </header>
          <div className="ranking-rows">
            {visibleRankedServices.map((service, index) => {
              const primaryValue =
                rankingMetric === "cpu" ? (service.cpu_percent ?? 0) : (service.memory_bytes ?? 0);
              const primaryLabel =
                rankingMetric === "cpu"
                  ? formatMonitoringPercent(service.cpu_percent)
                  : formatBytes(service.memory_bytes);
              const secondaryLabel =
                rankingMetric === "cpu"
                  ? `${formatBytes(service.memory_bytes)} ${labels.memory}`
                  : `${formatMonitoringPercent(service.cpu_percent)} CPU`;
              return (
                <div key={service.id} className="ranking-row">
                  <span className="ranking-position" aria-label={`${labels.rank} ${index + 1}`}>
                    {index + 1}
                  </span>
                  <span className="ranking-service">
                    <ServiceMonogram name={formatMonitoringServiceName(service.service_name)} />
                    <span>
                      <strong>{formatMonitoringServiceName(service.service_name)}</strong>
                      <small>
                        <i aria-hidden="true" />
                        {labels.running} · {secondaryLabel} ·{" "}
                        {formatDuration(service.uptime_seconds, language)}
                      </small>
                    </span>
                  </span>
                  <ResourceBar
                    value={primaryValue}
                    max={rankingMax}
                    label={primaryLabel}
                    purple={rankingMetric === "memory"}
                  />
                </div>
              );
            })}
            {!servicesQuery.isLoading && visibleRankedServices.length === 0 ? (
              <div className="ranking-empty">{labels.noRunningServices}</div>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}

function MonitorMetric({
  label,
  value,
  tone
}: {
  label: string;
  value: ReactNode;
  tone: "primary" | "success" | "purple" | "error";
}) {
  return (
    <div className="monitor-metric">
      <span>{label}</span>
      <strong className={`tone-${tone}`}>{value}</strong>
    </div>
  );
}

function ResourceBar({
  value,
  max,
  label,
  purple = false
}: {
  value: number;
  max: number;
  label: string;
  purple?: boolean;
}) {
  const percent = Math.min(100, Math.max(0, (value / Math.max(max, 1)) * 100));
  return (
    <span className={`resource-bar${purple ? " purple" : ""}`}>
      <span>{label}</span>
      <i>
        <b style={{ width: `${percent}%` }} />
      </i>
    </span>
  );
}

function formatMonitoringPercent(value?: number | null) {
  if (value == null) return "-";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

function ServiceMonogram({ name }: { name: string }) {
  return (
    <span className="service-monogram" aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  );
}

const MONITOR_CHART_COLOR = "#1478f2";
const MONITOR_CHART_FOCUS_COLOR = "#e5484d";
const MONITOR_CHART_WINDOW_MS = 10 * 60_000;
const MONITOR_CHART_WINDOW_MINUTES = MONITOR_CHART_WINDOW_MS / 60_000;

function ResourceChart({
  title,
  metric,
  points,
  language,
  emptyMessage
}: {
  title: string;
  metric: "cpu" | "memory";
  points: ResourceMetricPointDto[];
  language: "en" | "zh";
  emptyMessage: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hovered, setHovered] = useState<{
    point: ResourceMetricPointDto;
    x: number;
    y: number;
  } | null>(null);
  const height = 270;
  const plot = { left: 52, right: 18, top: 18, bottom: 38 };
  const sortedPoints = useMemo(
    () =>
      [...points].sort(
        (left, right) =>
          new Date(left.captured_at).getTime() - new Date(right.captured_at).getTime()
      ),
    [points]
  );
  const lastPoint = sortedPoints[sortedPoints.length - 1];
  const end = lastPoint
    ? Math.ceil(new Date(lastPoint.captured_at).getTime() / 1_000) * 1_000
    : Math.floor(Date.now() / 1_000) * 1_000;
  const start = end - MONITOR_CHART_WINDOW_MS;
  const visiblePoints = useMemo(() => {
    const windowPoints = sortedPoints.filter((point) => {
      const timestamp = new Date(point.captured_at).getTime();
      return timestamp >= start && timestamp <= end;
    });
    const firstPointTime = sortedPoints[0]
      ? new Date(sortedPoints[0].captured_at).getTime()
      : Number.POSITIVE_INFINITY;
    if (firstPointTime < start && lastPoint && windowPoints.length) {
      windowPoints.unshift(interpolateMetricAt(sortedPoints, start));
    }
    return windowPoints;
  }, [sortedPoints, start, end, lastPoint]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateWidth = () => setWidth(Math.max(320, stage.clientWidth));
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const maxValue =
    metric === "cpu"
      ? 100
      : Math.max(
          128 * 1024 ** 2,
          Math.max(...visiblePoints.map((point) => point.total_memory_bytes ?? 0), 0),
          Math.max(...visiblePoints.map((point) => point.memory_bytes ?? 0), 0)
        );
  const xFor = (value: string) =>
    plot.left +
    ((new Date(value).getTime() - start) / Math.max(end - start, 1)) *
      (width - plot.left - plot.right);
  const valueFor = (point: ResourceMetricPointDto) =>
    metric === "cpu"
      ? Math.min(100, Math.max(0, point.cpu_percent ?? 0))
      : Math.max(0, point.memory_bytes ?? 0);
  const yFor = (value: number) =>
    plot.top + (1 - value / Math.max(maxValue, 1)) * (height - plot.top - plot.bottom);
  const formatValue = (value: number) =>
    metric === "cpu" ? `${value.toFixed(1)}%` : formatBytes(value);
  const tickCount = 4;
  const timeTicks = useMemo(() => {
    const labelCount = 5;
    return Array.from(
      { length: labelCount },
      (_, index) => start + ((end - start) * index) / (labelCount - 1)
    );
  }, [start, end]);

  useEffect(() => {
    setHovered((current) => {
      if (!current || !visiblePoints.length) return current;
      const targetTime =
        Math.round(
          (start +
            ((current.x - plot.left) / Math.max(width - plot.left - plot.right, 1)) *
              (end - start)) /
            1_000
        ) * 1_000;
      const firstVisibleTime = new Date(visiblePoints[0].captured_at).getTime();
      const lastVisibleTime = new Date(
        visiblePoints[visiblePoints.length - 1].captured_at
      ).getTime();
      if (targetTime < firstVisibleTime || targetTime > lastVisibleTime) return null;
      const point = interpolateMetricAt(visiblePoints, targetTime);
      const value =
        metric === "cpu"
          ? Math.min(100, Math.max(0, point.cpu_percent ?? 0))
          : Math.max(0, point.memory_bytes ?? 0);
      const y = plot.top + (1 - value / Math.max(maxValue, 1)) * (height - plot.top - plot.bottom);
      return { point, x: current.x, y };
    });
  }, [
    end,
    maxValue,
    metric,
    plot.bottom,
    plot.left,
    plot.right,
    plot.top,
    start,
    visiblePoints,
    width
  ]);

  const handleChartMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!visiblePoints.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * width;
    const svgY = ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * height;
    const rawTargetTime =
      start + ((svgX - plot.left) / (width - plot.left - plot.right)) * (end - start);
    const targetTime = Math.round(Math.min(end, Math.max(start, rawTargetTime)) / 1_000) * 1_000;
    const firstVisibleTime = new Date(visiblePoints[0].captured_at).getTime();
    const lastVisibleTime = new Date(visiblePoints[visiblePoints.length - 1].captured_at).getTime();
    if (
      rawTargetTime < firstVisibleTime ||
      rawTargetTime > lastVisibleTime ||
      svgY < plot.top ||
      svgY > height - plot.bottom
    ) {
      setHovered(null);
      return;
    }
    const point = interpolateMetricAt(visiblePoints, targetTime);
    const pointY = yFor(valueFor(point));
    if (svgY > pointY) {
      setHovered(null);
      return;
    }
    setHovered({ point, x: xFor(point.captured_at), y: pointY });
  };

  return (
    <section className="monitor-panel chart-panel">
      <header className="chart-header">
        <h2>{title}</h2>
      </header>
      <div
        ref={stageRef}
        className="chart-stage"
        onMouseMove={handleChartMouseMove}
        onMouseLeave={() => setHovered(null)}
      >
        {visiblePoints.length ? (
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={MONITOR_CHART_COLOR} stopOpacity="0.78" />
                <stop offset="100%" stopColor={MONITOR_CHART_COLOR} stopOpacity="0.42" />
              </linearGradient>
              <clipPath id={`${gradientId}-plot-clip`}>
                <rect
                  x={plot.left}
                  y={plot.top}
                  width={width - plot.left - plot.right}
                  height={height - plot.top - plot.bottom}
                />
              </clipPath>
            </defs>
            {Array.from({ length: tickCount + 1 }, (_, index) => {
              const value = (maxValue / tickCount) * (tickCount - index);
              const y = yFor(value);
              return (
                <g key={index}>
                  <line
                    x1={plot.left}
                    x2={width - plot.right}
                    y1={y}
                    y2={y}
                    className="chart-gridline"
                  />
                  <text x={plot.left - 9} y={y + 4} textAnchor="end" className="chart-axis-label">
                    {metric === "cpu" ? Math.round(value) : formatCompactMemory(value)}
                  </text>
                </g>
              );
            })}
            {timeTicks.map((timestamp, index) => {
              const date = new Date(timestamp);
              const x =
                plot.left +
                ((timestamp - start) / (end - start)) * (width - plot.left - plot.right);
              return (
                <text
                  key={timestamp}
                  x={x}
                  y={height - 10}
                  textAnchor={
                    index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle"
                  }
                  className="chart-axis-label"
                >
                  {formatChartTime(date, language)}
                </text>
              );
            })}
            {(() => {
              const coordinates = visiblePoints.map((point) => ({
                x: xFor(point.captured_at),
                y: yFor(valueFor(point))
              }));
              if (coordinates.length === 1) {
                coordinates.push({ x: width - plot.right, y: coordinates[0].y });
              }
              const path = buildLinearChartPath(coordinates);
              const lastCoordinate = coordinates[coordinates.length - 1];
              const areaPath = path
                ? `${path} L ${lastCoordinate.x.toFixed(1)} ${height - plot.bottom} L ${coordinates[0].x.toFixed(1)} ${height - plot.bottom} Z`
                : "";
              return (
                <g className="chart-series" clipPath={`url(#${gradientId}-plot-clip)`}>
                  {coordinates.length > 1 ? (
                    <path d={areaPath} fill={`url(#${gradientId})`} className="chart-area" />
                  ) : null}
                  <path
                    d={path}
                    fill="none"
                    stroke={MONITOR_CHART_COLOR}
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className="chart-line"
                  />
                </g>
              );
            })()}
            {hovered ? (
              <g className="chart-focus">
                <line x1={hovered.x} x2={hovered.x} y1={plot.top} y2={height - plot.bottom} />
                <line x1={plot.left} x2={width - plot.right} y1={hovered.y} y2={hovered.y} />
                <circle
                  cx={hovered.x}
                  cy={hovered.y}
                  r="4.5"
                  fill="#ffffff"
                  stroke={MONITOR_CHART_FOCUS_COLOR}
                  strokeWidth="2.5"
                />
              </g>
            ) : null}
          </svg>
        ) : (
          <div className="chart-empty">{emptyMessage}</div>
        )}
        {hovered ? (
          <div
            className="chart-tooltip"
            style={{
              left: `${(hovered.x / width) * 100}%`,
              top: `${Math.max(8, (hovered.y / height) * 100 - 8)}%`
            }}
          >
            <strong>
              {new Date(hovered.point.captured_at).toLocaleTimeString(
                language === "zh" ? "zh-CN" : "en-US",
                { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
              )}
            </strong>
            <span>
              <i style={{ background: MONITOR_CHART_COLOR }} />
              {language === "zh" ? "总计" : "Total"} {formatValue(valueFor(hovered.point))}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function buildLinearChartPath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return "";
  return points
    .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function interpolateMetricAt(points: ResourceMetricPointDto[], requestedTime: number) {
  const first = points[0];
  const last = points[points.length - 1];
  const firstTime = new Date(first.captured_at).getTime();
  const lastTime = new Date(last.captured_at).getTime();
  const targetTime = Math.min(lastTime, Math.max(firstTime, requestedTime));
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (new Date(points[middle].captured_at).getTime() < targetTime) low = middle + 1;
    else high = middle;
  }
  const next = points[low];
  const previous = points[Math.max(0, low - 1)];
  const previousTime = new Date(previous.captured_at).getTime();
  const nextTime = new Date(next.captured_at).getTime();
  const ratio =
    nextTime === previousTime ? 0 : (targetTime - previousTime) / (nextTime - previousTime);
  const interpolate = (from?: number | null, to?: number | null) => {
    if (from == null) return to ?? null;
    if (to == null) return from;
    return from + (to - from) * ratio;
  };
  return {
    service_id: "system",
    cpu_percent: interpolate(previous.cpu_percent, next.cpu_percent),
    memory_bytes: interpolate(previous.memory_bytes, next.memory_bytes),
    total_memory_bytes: next.total_memory_bytes ?? previous.total_memory_bytes,
    captured_at: new Date(targetTime).toISOString()
  } satisfies ResourceMetricPointDto;
}

function getMonitoringLabels(language: "en" | "zh") {
  return language === "zh"
    ? {
        summary: "监控概览",
        running: "运行中",
        memory: "内存",
        resourceTrend: "资源趋势",
        cpuUsage: "CPU 使用率 (%)",
        memoryUsage: "内存使用",
        resourceRanking: "资源消耗排行",
        rankingMetric: "排行指标",
        rank: "排名",
        service: "服务",
        status: "状态",
        uptime: "运行时长",
        loadingTrends: "正在加载资源数据…",
        waitingForTrendData: "等待首次资源采样…",
        noRunningServices: "当前没有运行中的服务"
      }
    : {
        summary: "Monitoring overview",
        running: "Running",
        memory: "Memory",
        resourceTrend: "Resource trend",
        cpuUsage: "CPU usage (%)",
        memoryUsage: "Memory usage",
        resourceRanking: "Resource usage ranking",
        rankingMetric: "Ranking metric",
        rank: "Rank",
        service: "Service",
        status: "Status",
        uptime: "Uptime",
        loadingTrends: "Loading resource data…",
        waitingForTrendData: "Waiting for the first resource sample…",
        noRunningServices: "No services are running"
      };
}

function formatMonitoringServiceName(name: string) {
  if (/^elasticsearch/i.test(name)) return "Elasticsearch";
  if (/^postgresql/i.test(name))
    return name.replace(/^postgresql/i, "PostgreSQL").replace("@", " ");
  if (/^redis$/i.test(name)) return "Redis";
  if (/^minio$/i.test(name)) return "MinIO";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatCompactMemory(bytes: number) {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatChartTime(date: Date, language: "en" | "zh") {
  return date.toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function SettingsView() {
  const queryClient = useQueryClient();
  const language = useUiStore((state) => state.language);
  const setLanguage = useUiStore((state) => state.setLanguage);
  const refreshMode = useUiStore((state) => state.refreshMode);
  const setRefreshMode = useUiStore((state) => state.setRefreshMode);
  const reduceRefreshInBackground = useUiStore((state) => state.reduceRefreshInBackground);
  const setReduceRefreshInBackground = useUiStore((state) => state.setReduceRefreshInBackground);
  const { t } = useI18n();
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState<"metrics" | "history" | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const appInfoQuery = useQuery({ queryKey: ["app-info"], queryFn: api.getAppInfo });
  const appInfo = appInfoQuery.data;
  const clearDataMutation = useMutation({
    mutationFn: (target: "metrics" | "history") =>
      target === "metrics" ? api.clearMonitoringData() : api.clearOperationHistory(),
    onSuccess: (result, target) => {
      setConfirmCleanup(null);
      setCleanupNotice(t("cleanupComplete").replace("{count}", String(result.deleted_count)));
      if (target === "metrics") {
        queryClient.invalidateQueries({ queryKey: ["resource-metrics"] });
        queryClient.invalidateQueries({ queryKey: ["system-resource-metrics"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["activity"] });
      }
      queryClient.invalidateQueries({ queryKey: ["app-info"] });
    },
    onError: (error) => setCleanupNotice(formatTauriError(error))
  });
  const copyDiagnostics = async () => {
    const diagnostics = [
      `Locers ${appInfo?.version ?? "0.1.0"}`,
      `Provider: ${appInfo?.provider ?? "Homebrew"}`,
      `Database: ${appInfo?.database_path ?? "Unavailable"}`,
      `Database size: ${formatBytes(appInfo?.database_size_bytes)}`,
      `Refresh mode: ${refreshMode}`,
      `Platform: ${globalThis.navigator.platform || "Unknown"}`,
      `User agent: ${globalThis.navigator.userAgent}`
    ].join("\n");
    const copied = await copyTextToClipboard(diagnostics);
    setDiagnosticsCopied(copied);
    if (copied) window.setTimeout(() => setDiagnosticsCopied(false), 1800);
  };
  const copyDatabasePath = async () => {
    if (!appInfo?.database_path) return;
    const copied = await copyTextToClipboard(appInfo.database_path);
    setPathCopied(copied);
    if (copied) window.setTimeout(() => setPathCopied(false), 1800);
  };
  return (
    <section className="single-pane settings-pane">
      <header className="toolbar">
        <div>
          <h1>{t("settings")}</h1>
        </div>
      </header>
      <div className="settings-sections">
        {cleanupNotice && (
          <div className="settings-notice" role="status">
            <Check size={15} /> {cleanupNotice}
            <button aria-label={t("dismiss")} onClick={() => setCleanupNotice(null)}>
              ×
            </button>
          </div>
        )}
        <SettingsSection icon={<Settings size={17} />} title={t("generalSettings")}>
          <SettingRow label={t("language")} description={t("languageDescription")}>
            <span className="language-select">
              <select
                className="language-select-control"
                aria-label={t("language")}
                value={language}
                onChange={(event) => setLanguage(event.target.value as "en" | "zh")}
              >
                <option value="en">{t("english")}</option>
                <option value="zh">{t("chinese")}</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </SettingRow>
        </SettingsSection>

        <SettingsSection icon={<Gauge size={17} />} title={t("monitoringSettings")}>
          <SettingRow
            label={t("refreshMode")}
            description={t(
              refreshMode === "energySaver"
                ? "energySaverDescription"
                : refreshMode === "realtime"
                  ? "realtimeDescription"
                  : "standardDescription"
            )}
          >
            <span className="language-select refresh-mode-select">
              <select
                className="language-select-control"
                aria-label={t("refreshMode")}
                value={refreshMode}
                onChange={(event) => setRefreshMode(event.target.value as typeof refreshMode)}
              >
                <option value="energySaver">{t("energySaver")}</option>
                <option value="standard">{t("standard")}</option>
                <option value="realtime">{t("realtime")}</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </SettingRow>
          <SettingRow
            label={t("backgroundRefresh")}
            description={t("backgroundRefreshDescription")}
          >
            <Toggle
              checked={reduceRefreshInBackground}
              label={t("backgroundRefresh")}
              onChange={setReduceRefreshInBackground}
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection icon={<HardDrive size={17} />} title={t("dataPrivacy")}>
          <SettingRow label={t("storage")} description={t("storageDescription")}>
            <span className="setting-value">
              SQLite · {formatBytes(appInfo?.database_size_bytes)}
            </span>
          </SettingRow>
          <SettingRow
            label={t("dataLocation")}
            description={appInfo?.database_path ?? t("loadingDetail")}
          >
            <button
              className="settings-action-button"
              onClick={() => void copyDatabasePath()}
              disabled={!appInfo}
            >
              {pathCopied ? <CopyCheck size={14} /> : <Copy size={14} />}
              {pathCopied ? t("pathCopied") : t("copyPath")}
            </button>
          </SettingRow>
          <SettingRow label={t("resourceRetention")} description={t("resourceRetentionValue")}>
            <CleanupButton onClick={() => setConfirmCleanup("metrics")} />
          </SettingRow>
          <SettingRow label={t("historyRetention")} description={t("historyRetentionValue")}>
            <CleanupButton onClick={() => setConfirmCleanup("history")} />
          </SettingRow>
          <SettingRow label={t("serviceLogsPolicy")} description={t("serviceLogsPolicyValue")} />
        </SettingsSection>

        <SettingsSection icon={<ShieldCheck size={17} />} title={t("securitySettings")}>
          <SettingRow label={t("privilegePolicy")} description={t("privilegePolicyValue")} />
          <SettingRow label={t("managedScope")} description={t("managedScopeValue")} />
        </SettingsSection>

        <SettingsSection icon={<Info size={17} />} title={t("aboutDiagnostics")}>
          <SettingRow label="Locers" description={appInfo?.version ?? t("loadingDetail")}>
            <button className="settings-action-button" onClick={copyDiagnostics}>
              {diagnosticsCopied ? <CopyCheck size={14} /> : <Copy size={14} />}
              {diagnosticsCopied ? t("diagnosticsCopied") : t("copyDiagnostics")}
            </button>
          </SettingRow>
          <SettingRow label={t("serviceProvider")} description={appInfo?.provider ?? "Homebrew"} />
        </SettingsSection>
      </div>
      {confirmCleanup && (
        <CleanupDialog
          target={confirmCleanup}
          pending={clearDataMutation.isPending}
          onCancel={() => setConfirmCleanup(null)}
          onConfirm={() => clearDataMutation.mutate(confirmCleanup)}
        />
      )}
    </section>
  );
}

function CleanupButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button className="settings-action-button cleanup-button" onClick={onClick}>
      <Trash2 size={14} />
      {t("clearData")}
    </button>
  );
}

function CleanupDialog({
  target,
  pending,
  onCancel,
  onConfirm
}: {
  target: "metrics" | "history";
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const isMetrics = target === "metrics";

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, pending]);

  return (
    <div className="dialog-backdrop" onMouseDown={() => !pending && onCancel()}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cleanup-dialog-title"
        aria-describedby="cleanup-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-danger-mark">
          <Trash2 size={20} />
        </div>
        <div className="dialog-content">
          <h2 id="cleanup-dialog-title">
            {t(isMetrics ? "clearMetricsTitle" : "clearHistoryTitle")}
          </h2>
          <p id="cleanup-dialog-description">
            {t(isMetrics ? "clearMetricsDescription" : "clearHistoryDescription")}
          </p>
          <div className="delete-scope">
            <p>{t("clearDataIrreversible")}</p>
            <p>{t(isMetrics ? "clearMetricsNotice" : "clearHistoryNotice")}</p>
          </div>
          <div className="dialog-actions">
            <button type="button" disabled={pending} onClick={onCancel}>
              {t("cancel")}
            </button>
            <button type="button" className="danger-button" disabled={pending} onClick={onConfirm}>
              {pending ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
              {pending ? t("clearing") : t("confirmClear")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsSection({
  icon,
  title,
  children
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2>
        {icon}
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function SettingRow({
  label,
  description,
  children
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`toggle ${checked ? "active" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function getRefreshIntervals(mode: "energySaver" | "standard" | "realtime") {
  if (mode === "energySaver") return { services: 60_000, runtime: 5_000, ports: 30_000 };
  if (mode === "realtime") return { services: 10_000, runtime: 1_000, ports: 5_000 };
  return { services: 30_000, runtime: 1_000, ports: 10_000 };
}

function RecentActivityTimeline({ operations }: { operations: OperationHistoryDto[] }) {
  const { t, language } = useI18n();
  const now = new Date();
  const cutoff = getRecentActivityCutoff(now);
  const timelineOperations = operations.filter((operation) => {
    const type = operation.operation_type.toLowerCase();
    const startedAt = new Date(operation.started_at);
    return (
      (type === "start" || type === "stop") &&
      !Number.isNaN(startedAt.getTime()) &&
      startedAt >= cutoff
    );
  });

  if (!timelineOperations.length) return <EmptyState title={t("noActivityRecorded")} />;

  return (
    <ol className="activity-timeline" aria-label={t("recentActivity")}>
      {timelineOperations.map((operation) => {
        const type = operation.operation_type.toLowerCase() as "start" | "stop";

        return (
          <li key={operation.id} className={`timeline-event timeline-event-${type}`}>
            <div className="timeline-rail" aria-hidden="true">
              <span className="timeline-node">
                {type === "start" ? <Play size={11} /> : <Square size={9} />}
              </span>
            </div>
            <article className="timeline-content">
              <header className="timeline-header">
                <strong>{type}</strong>
                <time dateTime={operation.started_at}>
                  {formatActivityTimestamp(operation.started_at, now, language)}
                </time>
              </header>
              <code className="timeline-command">
                <span aria-hidden="true">$</span>
                {operation.command.join(" ")}
              </code>
              <div
                className={`timeline-result${operation.exit_code === 0 ? "" : " timeline-result-error"}`}
              >
                {operation.exit_code === 0 ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={12} aria-hidden="true" />
                )}
                <span>exit {operation.exit_code}</span>
                <span aria-hidden="true">·</span>
                <span>{formatOperationDuration(operation.duration_ms)}</span>
              </div>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function getRecentActivityCutoff(now: Date) {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (RECENT_ACTIVITY_DAY_COUNT - 1));
  return cutoff;
}

function formatActivityTimestamp(value: string, now: Date, language: "en" | "zh") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const time = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return time;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${time}`;
}

function formatOperationDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="info-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="inline-error">
      <AlertTriangle size={15} />
      <span>{message}</span>
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return <div className="empty-state">{title}</div>;
}
