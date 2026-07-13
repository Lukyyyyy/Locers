import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../state/uiStore";
import { App } from "./App";
import { getDisplayUptimeSeconds } from "./format";

function serviceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "svc-redis",
    provider: "homebrew",
    service_name: "redis",
    formula: "redis",
    status: "running",
    user: "luky",
    ports: [6379],
    pid: 123,
    cpu_percent: 1.2,
    memory_bytes: 1024 * 1024 * 10,
    uptime_seconds: 42,
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function activityDate(daysAgo: number, hour: number, minute: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function mockDefaultInvoke(command: string) {
  if (command === "get_formula_catalog") {
    return Promise.resolve([
      {
        formula: "mysql",
        name: "mysql",
        description: "Open source relational database management system",
        version: "9.4.0",
        default_ports: [3306],
        recommended: true
      },
      {
        formula: "redis",
        name: "redis",
        description: "Persistent key-value database",
        version: "8.8.0",
        default_ports: [6379],
        recommended: true
      },
      {
        formula: "ollama",
        name: "ollama",
        description: "Create, run, and share large language models",
        version: "0.9.6",
        default_ports: [11434],
        recommended: false
      }
    ]);
  }
  if (command === "refresh_formula_catalog") return Promise.resolve([]);
  if (command === "get_formula_statuses") {
    return Promise.resolve([{ formula: "redis", installed: true, version: "7.2.5" }]);
  }
  if (command === "install_formula") {
    return Promise.resolve({
      formula: "mysql",
      command: ["brew", "install", "--formula", "mysql"],
      stdout: "installed",
      stderr: "",
      success: true,
      service_id: "svc-mysql"
    });
  }
  if (command === "get_app_info") {
    return Promise.resolve({
      version: "0.1.0",
      database_path: "/tmp/locers.sqlite3",
      database_size_bytes: 2048,
      provider: "Homebrew",
      metric_retention_hours: 25,
      operation_retention_days: 90,
      operation_history_limit: 10_000
    });
  }
  if (command === "clear_monitoring_data" || command === "clear_operation_history") {
    return Promise.resolve({ deleted_count: 12 });
  }
  if (command === "get_services") {
    return Promise.resolve([serviceFixture()]);
  }
  if (command === "get_service_detail") {
    return Promise.resolve({
      service: {
        id: "svc-redis",
        provider: "homebrew",
        service_name: "redis",
        formula: "redis",
        status: "running",
        user: "luky",
        plist_path: "/tmp/redis.plist",
        file_path: "/tmp/redis.plist",
        favorite: false,
        note: null,
        provider_metadata: {},
        updated_at: new Date().toISOString()
      },
      latest_snapshot: {
        service_id: "svc-redis",
        status: "running",
        pid: 123,
        cpu_percent: 1.2,
        memory_bytes: 1024 * 1024 * 10,
        uptime_seconds: 42,
        error_message: null,
        captured_at: new Date().toISOString()
      },
      ports: [
        {
          service_id: "svc-redis",
          pid: 123,
          port: 6379,
          protocol: "tcp",
          address: "127.0.0.1",
          process_name: "redis"
        }
      ],
      log_sources: [],
      history: [
        {
          id: "op-start",
          service_id: "svc-redis",
          provider: "homebrew",
          operation_type: "start",
          command: ["brew", "services", "start", "redis"],
          exit_code: 0,
          stdout_summary: "redis started",
          stderr_summary: "",
          error_message: null,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 10
        },
        {
          id: "op-restart",
          service_id: "svc-redis",
          provider: "homebrew",
          operation_type: "restart",
          command: ["brew", "services", "restart", "redis"],
          exit_code: 0,
          stdout_summary: "redis restarted",
          stderr_summary: "",
          error_message: null,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 10
        },
        {
          id: "op-stop-yesterday",
          service_id: "svc-redis",
          provider: "homebrew",
          operation_type: "stop",
          command: ["brew", "services", "stop", "redis"],
          exit_code: 0,
          stdout_summary: "redis stopped yesterday",
          stderr_summary: "",
          error_message: null,
          started_at: activityDate(1, 16, 15),
          finished_at: activityDate(1, 16, 15),
          duration_ms: 640
        },
        {
          id: "op-stop-two-days-ago",
          service_id: "svc-redis",
          provider: "homebrew",
          operation_type: "stop",
          command: ["brew", "services", "stop", "redis"],
          exit_code: 0,
          stdout_summary: "redis stopped two days ago",
          stderr_summary: "",
          error_message: null,
          started_at: activityDate(2, 9, 6),
          finished_at: activityDate(2, 9, 6),
          duration_ms: 820
        },
        {
          id: "op-start-three-days-ago",
          service_id: "svc-redis",
          provider: "homebrew",
          operation_type: "start",
          command: ["brew", "services", "start", "redis"],
          exit_code: 0,
          stdout_summary: "redis started three days ago",
          stderr_summary: "",
          error_message: null,
          started_at: activityDate(3, 15, 22),
          finished_at: activityDate(3, 15, 22),
          duration_ms: 950
        }
      ],
      command_preview: ["brew", "services", "restart", "redis"]
    });
  }
  if (command === "get_service_logs") {
    return Promise.resolve({ source: null, lines: [], error: null });
  }
  if (command === "get_ports") return Promise.resolve([]);
  if (command === "refresh_ports") {
    return Promise.resolve({
      refreshed_count: 0,
      duration_ms: 2,
      refreshed_at: new Date().toISOString()
    });
  }
  if (command === "get_operation_history") return Promise.resolve([]);
  if (command === "get_resource_metrics") return Promise.resolve([]);
  if (command === "get_system_resource_metrics") return Promise.resolve([]);
  if (command === "refresh_services") {
    return Promise.resolve({
      discovered_count: 1,
      duration_ms: 10,
      refreshed_at: new Date().toISOString()
    });
  }
  if (command === "refresh_runtime_metrics") {
    return Promise.resolve({
      discovered_count: 1,
      duration_ms: 3,
      refreshed_at: new Date().toISOString()
    });
  }
  if (command === "stop_service") {
    return Promise.resolve({
      operation: {
        id: "op-stop",
        service_id: "svc-redis",
        provider: "homebrew",
        operation_type: "stop",
        command: ["brew", "services", "stop", "redis"],
        exit_code: 0,
        stdout_summary: "redis stopped",
        stderr_summary: "",
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 10
      },
      command: ["brew", "services", "stop", "redis"],
      success: true,
      refresh: {
        discovered_count: 1,
        duration_ms: 10,
        refreshed_at: new Date().toISOString()
      }
    });
  }
  if (command === "start_service") {
    return Promise.resolve({
      operation: {
        id: "op-start-new",
        service_id: "svc-redis",
        provider: "homebrew",
        operation_type: "start",
        command: ["brew", "services", "start", "redis"],
        exit_code: 0,
        stdout_summary: "redis started",
        stderr_summary: "",
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 10
      },
      command: ["brew", "services", "start", "redis"],
      success: true,
      refresh: {
        discovered_count: 1,
        duration_ms: 10,
        refreshed_at: new Date().toISOString()
      }
    });
  }
  if (command === "remove_service") {
    return Promise.resolve({
      operation: {
        id: "op-remove",
        service_id: "svc-redis",
        provider: "homebrew",
        operation_type: "remove",
        command: ["brew", "uninstall", "--formula", "redis"],
        exit_code: 0,
        stdout_summary: "Uninstalling redis",
        stderr_summary: "",
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 10
      },
      command: ["brew", "uninstall", "--formula", "redis"],
      success: true,
      refresh: {
        discovered_count: 0,
        duration_ms: 10,
        refreshed_at: new Date().toISOString()
      }
    });
  }
  return Promise.resolve({});
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(mockDefaultInvoke)
}));

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(mockDefaultInvoke);
    useUiStore.setState({
      nav: "services",
      language: "en",
      selectedServiceId: null,
      statusFilter: "all",
      search: "",
      logQuery: ""
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the Locers product brand", () => {
    renderApp();
    expect(screen.getByText("Locers")).toBeInTheDocument();
  });

  it("uses the compact icon-only refresh button on the services page", () => {
    renderApp();
    const refreshButton = screen.getByRole("button", { name: "Refresh" });

    expect(refreshButton).toHaveClass("refresh-icon-button");
    expect(refreshButton).toHaveTextContent("");
    expect(refreshButton.closest(".filters")).not.toBeNull();
  });

  it("keeps page titles compact without extra descriptions", async () => {
    const user = userEvent.setup();
    renderApp();

    expect(
      screen.queryByText("Discovered Homebrew services, runtime state, ports, and operations.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Monitoring" }));
    expect(
      screen.queryByText("Understand resource usage and runtime changes across local services.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.queryByText("Local preferences backed by SQLite will live here.")
    ).not.toBeInTheDocument();
  });

  it("refreshes service snapshots automatically when the services page opens", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "redis" });
    expect(invoke).toHaveBeenCalledWith("refresh_services");
  });

  it("refreshes services before reading the initial service list", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "redis" });
    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(commands.indexOf("refresh_services")).toBeLessThan(commands.indexOf("get_services"));
  });

  it("refreshes runtime metrics separately from full discovery", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "redis" });
    expect(invoke).toHaveBeenCalledWith("refresh_runtime_metrics");
  });

  it("advances running service uptime locally between backend refreshes", () => {
    expect(
      getDisplayUptimeSeconds({
        status: "running",
        uptimeSeconds: 42,
        receivedAt: 1_000,
        now: 4_000
      })
    ).toBe(45);
  });

  it("renders discovered services with status and uptime", async () => {
    const { container } = renderApp();
    const row = await screen.findByRole("row", { name: /redis homebrew running 42s/i });
    expect(within(row).getByText("redis")).toBeInTheDocument();
    expect(within(row).getByText("Running")).toBeInTheDocument();
    expect(within(row).getByText("42s")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "redis" });
    expect(screen.getAllByText("42s")).toHaveLength(1);
    const inspector = container.querySelector(".inspector");
    expect(inspector).not.toBeNull();
    expect(within(inspector as HTMLElement).queryByText("Running")).not.toBeInTheDocument();
  });

  it("renders grouped settings and persists user preferences", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ nav: "settings" });
    const { container } = renderApp();

    const languageSelect = screen.getByRole("combobox", { name: "Language" });
    expect(languageSelect).toHaveClass("language-select-control");
    expect(container.querySelector(".settings-sections .language-select")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Monitoring & refresh" })).toBeInTheDocument();
    expect(await screen.findByText("/tmp/locers.sqlite3")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Refresh mode" }), "energySaver");
    expect(useUiStore.getState().refreshMode).toBe("energySaver");

    await user.click(screen.getByRole("switch", { name: "Reduce refresh in background" }));
    expect(useUiStore.getState().reduceRefreshInBackground).toBe(false);

    await user.selectOptions(languageSelect, "zh");
    expect(useUiStore.getState().language).toBe("zh");
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
  });

  it("requires confirmation before clearing monitoring data", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ nav: "settings" });
    renderApp();

    const clearButtons = await screen.findAllByRole("button", { name: "Clear" });
    await user.click(clearButtons[0]);
    expect(invoke).not.toHaveBeenCalledWith("clear_monitoring_data");
    expect(screen.getByRole("alertdialog", { name: "Clear monitoring data?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear now" }));
    expect(invoke).toHaveBeenCalledWith("clear_monitoring_data");
    expect(await screen.findByText("Cleanup complete: 12 records removed.")).toBeInTheDocument();
  });

  it("shows feedback after copying the database path", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    useUiStore.setState({ nav: "settings" });
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/tmp/locers.sqlite3");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("localizes the ports page title", async () => {
    useUiStore.setState({ language: "zh", nav: "ports" });

    renderApp();

    expect(await screen.findByRole("heading", { name: "端口" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ports" })).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("refresh_ports");
  });

  it("renders monitoring trends without a time-range control", async () => {
    const user = userEvent.setup();
    const metricPoint = {
      service_id: "svc-redis",
      cpu_percent: 1.2,
      memory_bytes: 10 * 1024 * 1024,
      captured_at: new Date().toISOString()
    };
    useUiStore.setState({ nav: "activity", language: "zh" });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_system_resource_metrics") return Promise.resolve([metricPoint]);
      return mockDefaultInvoke(command);
    });

    renderApp();

    expect(await screen.findByRole("heading", { name: "CPU 使用率 (%)" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "CPU 使用率 (%)" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "时间范围" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
    await user.click(
      within(screen.getByRole("tablist", { name: "资源趋势" })).getByRole("tab", {
        name: "内存"
      })
    );
    expect(screen.getByRole("heading", { name: "内存使用" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "内存使用" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("get_system_resource_metrics", { minutes: 10 });
  });

  it("waits for system trend samples independently of running services", async () => {
    useUiStore.setState({ nav: "activity", language: "zh" });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_services") {
        return Promise.resolve([serviceFixture({ status: "stopped", pid: null })]);
      }
      return mockDefaultInvoke(command);
    });

    renderApp();

    expect(await screen.findByText("等待首次资源采样…")).toBeInTheDocument();
    expect(screen.queryByText("正在积累趋势数据…")).not.toBeInTheDocument();
  });

  it("refreshes ports on entry and supports a manual refresh from the ports page", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ nav: "ports" });

    renderApp();

    await screen.findByText(/last updated/i);
    expect(invoke).toHaveBeenCalledWith("refresh_ports");
    expect(screen.getByRole("button", { name: "Refresh" }).closest(".filters")).not.toBeNull();
    expect(document.querySelector(".ports-pane .ports-table-wrap")).not.toBeNull();
    vi.mocked(invoke).mockClear();

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(invoke).toHaveBeenCalledWith("refresh_ports");
  });

  it("keeps the refresh icon quiet while an automatic refresh is pending", async () => {
    let finishRefresh: (value: unknown) => void = () => undefined;
    const pendingRefresh = new Promise((resolve) => {
      finishRefresh = resolve;
    });
    useUiStore.setState({ nav: "ports" });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "refresh_ports") return pendingRefresh;
      return mockDefaultInvoke(command);
    });

    renderApp();

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    expect(refreshButton.querySelector(".spin")).not.toBeInTheDocument();
    expect(screen.getByText("Last updated -")).toBeInTheDocument();
    await act(async () => {
      finishRefresh({ refreshed_count: 0, duration_ms: 2, refreshed_at: new Date().toISOString() });
      await pendingRefresh;
    });
  });

  it("shows managed service names instead of internal service ids", async () => {
    useUiStore.setState({ nav: "ports" });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_ports") {
        return Promise.resolve([
          {
            service_id: "svc-redis",
            pid: 123,
            port: 6379,
            protocol: "tcp",
            address: "127.0.0.1",
            process_name: "redis-server"
          }
        ]);
      }
      return mockDefaultInvoke(command);
    });

    renderApp();

    const row = await screen.findByRole("row", {
      name: /6379 redis-server 123 127\.0\.0\.1 redis/i
    });
    expect(within(row).getByText("redis")).toBeInTheDocument();
    expect(screen.queryByText("svc-redis")).not.toBeInTheDocument();
  });

  it("filters ports by port, process, PID, and managed service name", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ nav: "ports" });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_ports") {
        return Promise.resolve([
          {
            service_id: "svc-redis",
            pid: 123,
            port: 6379,
            protocol: "tcp",
            address: "127.0.0.1",
            process_name: "redis-server"
          },
          {
            service_id: null,
            pid: 456,
            port: 1420,
            protocol: "tcp",
            address: "[::1]",
            process_name: "node"
          }
        ]);
      }
      return mockDefaultInvoke(command);
    });
    renderApp();
    const input = screen.getByPlaceholderText("Search port, process, PID, or service");

    await screen.findByText("redis-server");
    const unmanagedRow = screen.getByRole("row", { name: /1420 node 456 \[::1\] -/i });
    expect(within(unmanagedRow).getByText("-")).toBeInTheDocument();
    await user.type(input, "6379");
    expect(screen.getByText("redis-server")).toBeInTheDocument();
    expect(screen.queryByText("node")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "node");
    expect(screen.getByText("node")).toBeInTheDocument();
    expect(screen.queryByText("redis-server")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "123");
    expect(screen.getByText("redis-server")).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "redis");
    expect(screen.getByText("redis-server")).toBeInTheDocument();
    expect(screen.getByText("redis")).toBeInTheDocument();
  });

  it("renders explicit error status when the backend still reports an error", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_services") {
        return Promise.resolve([
          serviceFixture({ status: "error", pid: null, uptime_seconds: null })
        ]);
      }
      return mockDefaultInvoke(command);
    });

    renderApp();
    const row = await screen.findByRole("row", { name: /redis homebrew error/i });
    expect(within(row).getByText("Error")).toBeInTheDocument();
  });

  it("shows recent activity in a separate service detail tab", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await screen.findByRole("heading", { name: "redis" });
    await user.click(screen.getByRole("tab", { name: "Recent Activity" }));
    expect(screen.getByText("brew services start redis")).toBeInTheDocument();
    expect(screen.queryByText("brew services restart redis")).not.toBeInTheDocument();
    expect(screen.queryByText("redis started")).not.toBeInTheDocument();

    const timeline = container.querySelector(".activity-timeline");
    expect(timeline).not.toBeNull();
    expect(timeline?.querySelectorAll(".timeline-event")).toHaveLength(3);
    const timestamps = Array.from(timeline?.querySelectorAll("time") ?? []).map(
      (time) => time.textContent
    );
    expect(timestamps[0]).toMatch(/^\d{2}:\d{2}$/);
    expect(timestamps[1]).toMatch(/^\d{2}-\d{2} 16:15$/);
    expect(timestamps[2]).toMatch(/^\d{2}-\d{2} 09:06$/);
  });

  it("starts with an empty log and shows only output from the next start", async () => {
    const user = userEvent.setup();
    let sessionStarted = false;
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_services") {
        return Promise.resolve([
          serviceFixture({ status: "stopped", pid: null, uptime_seconds: null })
        ]);
      }
      if (command === "start_service") {
        sessionStarted = true;
      }
      if (command === "get_service_logs") {
        return Promise.resolve({
          source: null,
          lines: sessionStarted ? ["redis ready"] : [],
          error: null
        });
      }
      return mockDefaultInvoke(command);
    });
    const { container } = renderApp();
    await screen.findByRole("heading", { name: "redis" });

    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.queryByText(/brew services start redis/)).not.toBeInTheDocument();
    expect(screen.queryByText(/redis ready/)).not.toBeInTheDocument();

    const logView = container.querySelector(".session-log") as HTMLElement;
    Object.defineProperties(logView, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 }
    });
    logView.scrollTop = 250;
    fireEvent.scroll(logView);

    await user.click(screen.getByRole("button", { name: /start/i }));

    expect(await screen.findByText(/\$ brew services start redis/)).toBeInTheDocument();
    expect(await screen.findByText(/redis ready/)).toBeInTheDocument();
    expect(logView.scrollTop).toBe(250);
    expect(invoke).toHaveBeenCalledWith("get_service_logs", {
      serviceId: "svc-redis",
      options: { max_lines: 2000, query: "" }
    });
  });

  it("copies all visible log text from the hover action", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_service_logs") {
        return Promise.resolve({
          source: null,
          lines: ["redis ready", "accepting connections"],
          error: null
        });
      }
      return mockDefaultInvoke(command);
    });

    renderApp();
    await screen.findByRole("heading", { name: "redis" });
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    const copyButton = await screen.findByRole("button", { name: "Copy logs" });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("redis ready\naccepting connections");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("falls back to selection-based log copying when clipboard access is denied", async () => {
    const user = userEvent.setup();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) }
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_service_logs") {
        return Promise.resolve({ source: null, lines: ["redis ready"], error: null });
      }
      return mockDefaultInvoke(command);
    });

    renderApp();
    await screen.findByRole("heading", { name: "redis" });
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    await user.click(await screen.findByRole("button", { name: "Copy logs" }));

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("restores the inspector viewport when the window is resized", async () => {
    const { container } = renderApp();
    await screen.findByRole("heading", { name: "redis" });
    const inspector = container.querySelector(".inspector");
    expect(inspector).not.toBeNull();

    if (inspector) {
      inspector.scrollTop = 500;
      inspector.scrollLeft = 300;
      act(() => window.dispatchEvent(new window.Event("resize")));
      expect(inspector.scrollTop).toBe(0);
      expect(inspector.scrollLeft).toBe(0);
    }
  });

  it("runs the row stop action without opening a confirmation panel", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: "redis" });
    await user.click(screen.getByRole("button", { name: /stop/i }));
    expect(invoke).toHaveBeenCalledWith("stop_service", { serviceId: "svc-redis" });
  });

  it("requires confirmation before removing a service", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: "redis" });

    await user.click(screen.getByRole("button", { name: "Uninstall service: redis" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("remove_service", expect.anything());

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Uninstall service: redis" }));
    await user.click(screen.getByRole("button", { name: /^Uninstall service$/ }));
    expect(invoke).toHaveBeenCalledWith("remove_service", { serviceId: "svc-redis" });
  });

  it("installs a catalog service after confirmation", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));
    await screen.findByRole("heading", { name: "Install" });

    const mysqlCard = screen.getByRole("heading", { name: "MySQL" }).closest("article");
    expect(mysqlCard).not.toBeNull();
    await user.click(within(mysqlCard!).getByRole("button", { name: "Install" }));
    expect(screen.getByText("brew install --formula mysql")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Install" })
    );

    expect(invoke).toHaveBeenCalledWith("install_formula", { formula: "mysql" });
    expect(await screen.findByText("MySQL was installed successfully.")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        vi.mocked(invoke).mock.calls.filter(([command]) => command === "get_formula_statuses")
          .length
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it("manually refreshes the install catalog and formula statuses", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));
    const refreshButton = await screen.findByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refreshButton).toBeEnabled());
    const refreshCallsBefore = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "refresh_formula_catalog").length;

    await user.click(refreshButton);

    await waitFor(() => {
      expect(
        vi.mocked(invoke).mock.calls.filter(([command]) => command === "refresh_formula_catalog")
          .length
      ).toBeGreaterThan(refreshCallsBefore);
    });
    expect(refreshButton).toHaveClass("refresh-icon-button");
  });

  it("shows and searches services returned by the dynamic Homebrew catalog", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));

    expect(await screen.findByRole("heading", { name: "Ollama" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All 3" })).toBeInTheDocument();
    expect(screen.getByText("Version 0.9.6")).toBeInTheDocument();
    expect(screen.getByText("Default port 11434")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search services"), "large language");
    expect(screen.getByRole("heading", { name: "Ollama" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "MySQL" })).not.toBeInTheDocument();
  });

  it("automatically reveals more install services when the list bottom approaches", async () => {
    type TestIntersectionCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
    let intersectionCallback: TestIntersectionCallback | undefined;
    class IntersectionObserverMock {
      readonly root = null;
      readonly rootMargin = "240px 0px";
      readonly thresholds = [0];
      constructor(callback: TestIntersectionCallback) {
        intersectionCallback = callback;
      }
      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);

    const catalog = Array.from({ length: 41 }, (_, index) => ({
      formula: `service-${index}`,
      name: `service-${index}`,
      description: `Test service ${index}`,
      version: "1.0.0",
      default_ports: [],
      recommended: false
    }));
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_formula_catalog") return Promise.resolve(catalog);
      if (command === "refresh_formula_catalog" || command === "get_formula_statuses") {
        return Promise.resolve([]);
      }
      return mockDefaultInvoke(command);
    });

    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));

    expect(await screen.findByText("service-39")).toBeInTheDocument();
    expect(screen.queryByText("service-40")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show .* more/i })).not.toBeInTheDocument();

    act(() => {
      intersectionCallback?.([{ isIntersecting: true }]);
    });

    expect(await screen.findByText("service-40")).toBeInTheDocument();
  });

  it("uses Chinese catalog descriptions and hides undeclared ports", async () => {
    useUiStore.setState({ language: "zh" });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_formula_catalog") {
        return Promise.resolve([
          {
            formula: "aliddns",
            name: "aliddns",
            description: "Aliyun(Alibaba Cloud) ddns for golang",
            version: "0.0.23",
            default_ports: [],
            recommended: false
          }
        ]);
      }
      if (command === "refresh_formula_catalog" || command === "get_formula_statuses") {
        return Promise.resolve([]);
      }
      return mockDefaultInvoke(command);
    });

    renderApp();
    await userEvent.setup().click(screen.getByRole("button", { name: "安装" }));

    expect(await screen.findByText("DNS 与域名服务")).toBeInTheDocument();
    expect(screen.queryByText("Aliyun(Alibaba Cloud) ddns for golang")).not.toBeInTheDocument();
    expect(screen.queryByText(/默认端口/)).not.toBeInTheDocument();
    expect(screen.getByText("版本 0.0.23")).toBeInTheDocument();
  });

  it("filters the install catalog to installed services", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));
    await screen.findByRole("heading", { name: "Install" });

    await user.click(screen.getByRole("tab", { name: "Installed 1" }));

    expect(screen.getByRole("heading", { name: "Redis" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "MySQL" })).not.toBeInTheDocument();
  });

  it("filters and upgrades an outdated catalog service after confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_formula_statuses") {
        return Promise.resolve([
          {
            formula: "redis",
            installed: true,
            version: "8.8.0",
            outdated: true,
            current_version: "8.8.1"
          }
        ]);
      }
      if (command === "upgrade_formula") {
        return Promise.resolve({
          formula: "redis",
          command: ["brew", "upgrade", "--formula", "redis"],
          stdout: "upgraded",
          stderr: "",
          success: true,
          service_id: "svc-redis"
        });
      }
      return mockDefaultInvoke(command);
    });

    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));
    const updatesTab = await screen.findByRole("tab", { name: "Updates 1" });
    const redisInAll = screen.getByRole("heading", { name: "Redis" }).closest("article");
    expect(within(redisInAll!).queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(within(redisInAll!).getByText("Installed 8.8.0")).toBeInTheDocument();

    await user.click(updatesTab);

    expect(screen.getByRole("heading", { name: "Redis" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "MySQL" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByText("Installed 8.8.0 → available 8.8.1")).toBeInTheDocument();
    expect(screen.getByText("brew upgrade --formula redis")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Update" })
    );

    expect(invoke).toHaveBeenCalledWith("upgrade_formula", { formula: "redis" });
    expect(await screen.findByText("Redis was updated successfully.")).toBeInTheDocument();
  });

  it("does not show a zero installed count while statuses are loading", async () => {
    const user = userEvent.setup();
    let resolveStatuses: (value: unknown) => void = () => undefined;
    const pendingStatuses = new Promise((resolve) => {
      resolveStatuses = resolve;
    });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "get_formula_statuses") return pendingStatuses;
      return mockDefaultInvoke(command);
    });

    renderApp();
    await user.click(screen.getByRole("button", { name: "Install" }));

    const installedTab = screen.getByRole("tab", { name: "Installed …" });
    expect(installedTab).toBeDisabled();
    expect(screen.queryByRole("tab", { name: "Installed 0" })).not.toBeInTheDocument();

    resolveStatuses([{ formula: "redis", installed: true, version: "7.2.5" }]);

    expect(await screen.findByRole("tab", { name: "Installed 1" })).toBeEnabled();
  });

  it("filters services with the custom status listbox", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: "redis" });

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(screen.getByRole("option", { name: "Stopped" }));

    expect(useUiStore.getState().statusFilter).toBe("stopped");
    expect(screen.getByText("No services discovered")).toBeInTheDocument();
  });

  it("keeps other service action buttons enabled while one service operation is pending", async () => {
    const user = userEvent.setup();
    let resolveStop: (value: unknown) => void = () => undefined;
    const pendingStop = new Promise((resolve) => {
      resolveStop = resolve;
    });

    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "get_services") {
        return Promise.resolve([
          serviceFixture(),
          serviceFixture({
            id: "svc-kafka",
            service_name: "kafka",
            formula: "kafka",
            status: "stopped",
            pid: null,
            uptime_seconds: null
          })
        ]);
      }
      if (command === "stop_service") {
        expect(args).toEqual({ serviceId: "svc-redis" });
        return pendingStop;
      }
      return mockDefaultInvoke(command);
    });

    renderApp();
    await screen.findByRole("row", { name: /kafka homebrew stopped/i });
    await user.click(screen.getByRole("button", { name: /stop/i }));

    expect(screen.getByRole("button", { name: /start/i })).toBeEnabled();
    await act(async () => {
      resolveStop({
        operation: {
          id: "op-stop",
          service_id: "svc-redis",
          provider: "homebrew",
          operation_type: "stop",
          command: ["brew", "services", "stop", "redis"],
          exit_code: 0,
          stdout_summary: "redis stopped",
          stderr_summary: "",
          error_message: null,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 10
        },
        command: ["brew", "services", "stop", "redis"],
        success: true,
        refresh: {
          discovered_count: 2,
          duration_ms: 10,
          refreshed_at: new Date().toISOString()
        }
      });
      await pendingStop;
    });
  });
});
