mod command_runner;
mod db;
mod error;
mod homebrew;
mod models;
mod system_probe;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use command_runner::CommandRunner;
use db::Database;
use error::{AppError, AppResult};
use homebrew::{HomebrewProvider, ServiceProvider};
use models::{
    AppInfoDto, DataCleanupResultDto, FormulaInstallResultDto, FormulaStatusDto,
    FormulaUpgradeResultDto, LogReadOptionsDto, LogReadResultDto, OperationHistoryDto,
    OperationResultDto, PortBindingDto, PortRefreshResultDto, RefreshResultDto,
    ResourceMetricPointDto, RuntimeMetricsRefreshResultDto, ServiceDetailDto, ServiceStatus,
    ServiceSummaryDto,
};
use tauri::{async_runtime, AppHandle, Manager, State};

struct AppState {
    db: Mutex<Database>,
    db_path: PathBuf,
    provider: HomebrewProvider,
    log_session_offsets: Mutex<HashMap<String, HashMap<String, u64>>>,
    runtime_metrics: Mutex<RuntimeMetricsState>,
    system_metrics: Mutex<sysinfo::System>,
    started_at: chrono::DateTime<chrono::Utc>,
}

const RUNTIME_SNAPSHOT_PERSIST_INTERVAL: Duration = Duration::from_secs(10);
const MIN_RUNTIME_SAMPLE_INTERVAL: Duration = Duration::from_millis(500);
const DATABASE_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const INSTALLABLE_FORMULAE: &[&str] = &[
    "postgresql@16",
    "mysql",
    "redis",
    "rabbitmq",
    "kafka",
    "nginx",
    "caddy",
    "memcached",
    "meilisearch",
    "minio",
];

fn validate_installable_formula(formula: &str) -> AppResult<()> {
    if INSTALLABLE_FORMULAE.contains(&formula) {
        Ok(())
    } else {
        Err(AppError::Command(format!(
            "formula is not available in the Locers catalog: {formula}"
        )))
    }
}

#[tauri::command]
async fn get_formula_statuses(app: AppHandle) -> AppResult<Vec<FormulaStatusDto>> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Both commands are read-only and independent. Running them together keeps
        // the first paint bounded by the slower command instead of their sum.
        let outdated_provider = state.provider.clone();
        let installed_provider = state.provider.clone();
        let outdated_task = std::thread::spawn(move || outdated_provider.outdated_formulae());
        let installed_task = std::thread::spawn(move || installed_provider.installed_formulae());
        let outdated: HashMap<_, _> = outdated_task
            .join()
            .map_err(|_| AppError::Command("Homebrew outdated task panicked".into()))??
            .into_iter()
            .map(|(formula, installed, current)| (formula, (installed, current)))
            .collect();
        let installed: HashMap<_, _> = installed_task
            .join()
            .map_err(|_| AppError::Command("Homebrew installed formula task panicked".into()))??
            .into_iter()
            .collect();
        INSTALLABLE_FORMULAE
            .iter()
            .map(|formula| {
                let available_update = outdated.get(*formula);
                Ok(FormulaStatusDto {
                    formula: (*formula).into(),
                    installed: installed.contains_key(*formula),
                    version: installed
                        .get(*formula)
                        .cloned()
                        .or_else(|| available_update.and_then(|item| item.0.clone())),
                    outdated: available_update.is_some(),
                    current_version: available_update.and_then(|item| item.1.clone()),
                })
            })
            .collect()
    })
    .await
    .map_err(|err| AppError::Command(format!("formula status task failed: {err}")))?
}

#[tauri::command]
async fn upgrade_formula(app: AppHandle, formula: String) -> AppResult<FormulaUpgradeResultDto> {
    validate_installable_formula(&formula)?;
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let service = state
            .db
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .list_services()?
            .into_iter()
            .find(|service| service.formula == formula);
        let service_id = service.as_ref().map(|service| service.id.clone());
        let command = vec![
            "brew".into(),
            "upgrade".into(),
            "--formula".into(),
            formula.clone(),
        ];
        let output = state.provider.upgrade(&formula)?;
        if let Some(service) = &service {
            state
                .db
                .lock()
                .map_err(|_| AppError::StatePoisoned)?
                .record_operation(
                    &service.id,
                    &service.provider,
                    "upgrade",
                    &command,
                    output.exit_code,
                    output.duration_ms,
                    &output.stdout,
                    &output.stderr,
                    (output.exit_code != 0).then_some("Homebrew upgrade failed"),
                )?;
        }
        if output.exit_code != 0 {
            return Err(AppError::OperationFailed {
                message: "Homebrew upgrade failed".into(),
                operation: None,
            });
        }
        refresh_services_blocking(&state)?;
        Ok(FormulaUpgradeResultDto {
            formula,
            command,
            stdout: output.stdout,
            stderr: output.stderr,
            success: true,
            service_id,
        })
    })
    .await
    .map_err(|err| AppError::Command(format!("upgrade task failed: {err}")))?
}

#[tauri::command]
async fn install_formula(app: AppHandle, formula: String) -> AppResult<FormulaInstallResultDto> {
    validate_installable_formula(&formula)?;
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let command = vec![
            "brew".into(),
            "install".into(),
            "--formula".into(),
            formula.clone(),
        ];
        let output = state.provider.install(&formula)?;
        if output.exit_code != 0 {
            return Err(AppError::OperationFailed {
                message: "Homebrew install failed".into(),
                operation: None,
            });
        }

        refresh_services_blocking(&state)?;
        let service = state
            .db
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .list_services()?
            .into_iter()
            .find(|service| service.formula == formula);
        let service_id = service.as_ref().map(|service| service.id.clone());
        if let Some(service) = service {
            state
                .db
                .lock()
                .map_err(|_| AppError::StatePoisoned)?
                .record_operation(
                    &service.id,
                    &service.provider,
                    "install",
                    &command,
                    output.exit_code,
                    output.duration_ms,
                    &output.stdout,
                    &output.stderr,
                    None,
                )?;
        }
        Ok(FormulaInstallResultDto {
            formula,
            command,
            stdout: output.stdout,
            stderr: output.stderr,
            success: true,
            service_id,
        })
    })
    .await
    .map_err(|err| AppError::Command(format!("install task failed: {err}")))?
}

struct RuntimeMetricsState {
    collector: system_probe::RuntimeMetricsCollector,
    latest: HashMap<String, models::ServiceSnapshot>,
    last_collected_at: Option<Instant>,
    last_persisted_at: Option<Instant>,
}

impl RuntimeMetricsState {
    fn new() -> Self {
        Self {
            collector: system_probe::RuntimeMetricsCollector::new(),
            latest: HashMap::new(),
            last_collected_at: None,
            last_persisted_at: None,
        }
    }

    fn collect(
        &mut self,
        services: &[models::ManagedService],
        ports: &[PortBindingDto],
        force_persist: bool,
    ) -> (Vec<models::ServiceSnapshot>, bool) {
        let should_collect = self.latest.is_empty()
            || self
                .last_collected_at
                .is_none_or(|last| last.elapsed() >= MIN_RUNTIME_SAMPLE_INTERVAL);
        let snapshots = if should_collect {
            let snapshots = self.collector.collect(services, ports);
            self.latest = snapshots
                .iter()
                .cloned()
                .map(|snapshot| (snapshot.service_id.clone(), snapshot))
                .collect();
            self.last_collected_at = Some(Instant::now());
            snapshots
        } else {
            self.latest.values().cloned().collect()
        };
        let should_persist = force_persist
            || self
                .last_persisted_at
                .is_none_or(|last| last.elapsed() >= RUNTIME_SNAPSHOT_PERSIST_INTERVAL);
        if should_persist {
            self.last_persisted_at = Some(Instant::now());
        }
        (snapshots, should_persist)
    }
}

#[tauri::command]
async fn refresh_services(app: AppHandle) -> AppResult<RefreshResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        refresh_services_blocking(&state)
    })
    .await
    .map_err(|err| AppError::Command(format!("refresh task failed: {err}")))?
}

fn refresh_services_blocking(state: &AppState) -> AppResult<RefreshResultDto> {
    let started_at = chrono::Utc::now();
    let _provider_id = state.provider.id();
    let _provider_name = state.provider.display_name();
    let discovered = state.provider.discover()?;
    let services = {
        let mut db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        db.upsert_discovered_services(&discovered)?;
        db.list_services()?
    };
    let ports = system_probe::scan_listening_ports().unwrap_or_default();
    let attached_ports = {
        let mut db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        db.replace_ports(&ports)?;
        db.list_ports()?
    };
    let snapshots = state
        .runtime_metrics
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .collect(&services, &attached_ports, true)
        .0;
    let mut db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    for snapshot in &snapshots {
        db.insert_snapshot(snapshot)?;
    }
    for service in &services {
        let sources = state.provider.infer_log_sources(service);
        db.replace_log_sources(service.id.as_str(), &sources)?;
    }
    let duration_ms = (chrono::Utc::now() - started_at).num_milliseconds();
    Ok(RefreshResultDto {
        discovered_count: discovered.len() as i64,
        duration_ms,
        refreshed_at: chrono::Utc::now(),
    })
}

#[tauri::command]
async fn refresh_ports(app: AppHandle) -> AppResult<PortRefreshResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let started_at = chrono::Utc::now();
        let ports = system_probe::scan_listening_ports()?;
        let refreshed_count = ports.len() as i64;
        state
            .db
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .replace_ports(&ports)?;
        let duration_ms = (chrono::Utc::now() - started_at).num_milliseconds();
        Ok(PortRefreshResultDto {
            refreshed_count,
            duration_ms,
            refreshed_at: chrono::Utc::now(),
        })
    })
    .await
    .map_err(|err| AppError::Command(format!("port refresh task failed: {err}")))?
}

#[tauri::command]
async fn refresh_runtime_metrics(app: AppHandle) -> AppResult<RuntimeMetricsRefreshResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        refresh_runtime_metrics_blocking(&state)
    })
    .await
    .map_err(|err| AppError::Command(format!("runtime metrics refresh task failed: {err}")))?
}

fn refresh_runtime_metrics_blocking(state: &AppState) -> AppResult<RuntimeMetricsRefreshResultDto> {
    let started_at = chrono::Utc::now();
    let (services, ports) = {
        let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        (db.list_services()?, db.list_ports()?)
    };
    let (snapshots, should_persist) = state
        .runtime_metrics
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .collect(&services, &ports, false);
    if should_persist {
        let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        for snapshot in &snapshots {
            db.insert_snapshot(snapshot)?;
        }
    }
    let refreshed_count = snapshots.len() as i64;
    let duration_ms = (chrono::Utc::now() - started_at).num_milliseconds();
    Ok(RuntimeMetricsRefreshResultDto {
        refreshed_count,
        duration_ms,
        refreshed_at: chrono::Utc::now(),
    })
}

#[tauri::command]
fn get_services(state: State<'_, AppState>) -> AppResult<Vec<ServiceSummaryDto>> {
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    let mut summaries = db.list_service_summaries()?;
    drop(db);
    let metrics = state
        .runtime_metrics
        .lock()
        .map_err(|_| AppError::StatePoisoned)?;
    for summary in &mut summaries {
        if let Some(snapshot) = metrics.latest.get(&summary.id) {
            summary.pid = snapshot.pid;
            summary.cpu_percent = snapshot.cpu_percent;
            summary.memory_bytes = snapshot.memory_bytes;
            summary.uptime_seconds = snapshot.uptime_seconds;
        }
    }
    Ok(summaries)
}

#[tauri::command]
fn get_service_detail(
    state: State<'_, AppState>,
    service_id: String,
) -> AppResult<ServiceDetailDto> {
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    let mut detail = db.get_service_detail(&service_id)?;
    drop(db);
    if let Some(snapshot) = state
        .runtime_metrics
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .latest
        .get(&service_id)
    {
        detail.latest_snapshot = Some(snapshot.clone());
    }
    Ok(detail)
}

#[tauri::command]
async fn start_service(app: AppHandle, service_id: String) -> AppResult<OperationResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_service_operation(state, service_id, "start")
    })
    .await
    .map_err(|err| AppError::Command(format!("start task failed: {err}")))?
}

#[tauri::command]
async fn stop_service(app: AppHandle, service_id: String) -> AppResult<OperationResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_service_operation(state, service_id, "stop")
    })
    .await
    .map_err(|err| AppError::Command(format!("stop task failed: {err}")))?
}

#[tauri::command]
async fn restart_service(app: AppHandle, service_id: String) -> AppResult<OperationResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_service_operation(state, service_id, "restart")
    })
    .await
    .map_err(|err| AppError::Command(format!("restart task failed: {err}")))?
}

#[tauri::command]
async fn remove_service(app: AppHandle, service_id: String) -> AppResult<OperationResultDto> {
    async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_remove_service(state, service_id)
    })
    .await
    .map_err(|err| AppError::Command(format!("remove task failed: {err}")))?
}

fn run_remove_service(
    state: State<'_, AppState>,
    service_id: String,
) -> AppResult<OperationResultDto> {
    let service = {
        let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        db.get_service(&service_id)?
    };
    let command = state.provider.command_preview("remove", &service.formula);

    if service.status == ServiceStatus::Running {
        let stopped = state.provider.stop(&service.service_name)?;
        if stopped.exit_code != 0 {
            let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
            let operation = db.record_operation(
                &service.id,
                &service.provider,
                "remove",
                &command,
                stopped.exit_code,
                stopped.duration_ms,
                &stopped.stdout,
                &stopped.stderr,
                Some("failed to stop service before uninstall"),
            )?;
            return Err(AppError::OperationFailed {
                message: "failed to stop service before uninstall".to_string(),
                operation: Some(Box::new(operation)),
            });
        }
    }

    let output = state.provider.uninstall(&service.formula)?;
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    let error_message = (output.exit_code != 0).then_some("Homebrew uninstall failed");
    let operation = db.record_operation(
        &service.id,
        &service.provider,
        "remove",
        &command,
        output.exit_code,
        output.duration_ms,
        &output.stdout,
        &output.stderr,
        error_message,
    )?;
    drop(db);

    if output.exit_code != 0 {
        return Err(AppError::OperationFailed {
            message: "Homebrew uninstall failed".to_string(),
            operation: Some(Box::new(operation)),
        });
    }

    {
        let mut db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        db.mark_service_removed(&service_id)?;
    }
    state
        .runtime_metrics
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .latest
        .remove(&service_id);
    state
        .log_session_offsets
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .remove(&service_id);

    // A rediscovered formula clears removed_at, so success also verifies that Homebrew
    // no longer reports the service after uninstalling it.
    let refresh = refresh_services_blocking(&state)?;
    let removed = match state
        .db
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .get_service(&service_id)
    {
        Err(AppError::ServiceNotFound(_)) => true,
        Ok(_) => false,
        Err(error) => return Err(error),
    };
    if !removed {
        return Err(AppError::OperationFailed {
            message: "service is still reported by Homebrew after uninstall".to_string(),
            operation: Some(Box::new(operation)),
        });
    }

    Ok(OperationResultDto {
        operation,
        command,
        success: true,
        refresh,
    })
}

fn run_service_operation(
    state: State<'_, AppState>,
    service_id: String,
    operation_type: &str,
) -> AppResult<OperationResultDto> {
    let service = {
        let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        db.get_service(&service_id)?
    };

    let command = state
        .provider
        .command_preview(operation_type, service.service_name.as_str());
    if operation_type == "start" {
        let sources = {
            let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
            db.list_log_sources(&service_id)?
        };
        let offsets = system_probe::capture_log_offsets(&sources);
        state
            .log_session_offsets
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .insert(service_id.clone(), offsets);
    }
    let result = state
        .provider
        .run_operation(operation_type, service.service_name.as_str());

    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    match result {
        Ok(output) => {
            let operation = db.record_operation(
                service.id.as_str(),
                service.provider.as_str(),
                operation_type,
                &command,
                output.exit_code,
                output.duration_ms,
                &output.stdout,
                &output.stderr,
                None,
            )?;
            drop(db);
            let refresh = refresh_services_blocking(&state)?;
            // Verify the service actually reached the expected state after the refresh.
            let expected_status = match operation_type {
                "start" | "restart" => Some(ServiceStatus::Running),
                "stop" => Some(ServiceStatus::Stopped),
                _ => None,
            };
            let actual_status = {
                let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
                db.get_service(&service_id).ok().map(|svc| svc.status)
            };
            let success = output.exit_code == 0
                && expected_status.is_none_or(|expected| actual_status.as_ref() == Some(&expected));
            Ok(OperationResultDto {
                operation,
                command,
                success,
                refresh,
            })
        }
        Err(error) => {
            let operation = db.record_operation(
                service.id.as_str(),
                service.provider.as_str(),
                operation_type,
                &command,
                -1,
                0,
                "",
                "",
                Some(error.to_string().as_str()),
            )?;
            Err(AppError::OperationFailed {
                message: error.to_string(),
                operation: Some(Box::new(operation)),
            })
        }
    }
}

#[tauri::command]
fn get_service_logs(
    state: State<'_, AppState>,
    service_id: String,
    options: LogReadOptionsDto,
) -> AppResult<LogReadResultDto> {
    let offsets = state
        .log_session_offsets
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .get(&service_id)
        .cloned();
    let Some(offsets) = offsets else {
        return Ok(LogReadResultDto {
            source: None,
            lines: Vec::new(),
            error: None,
        });
    };
    let sources = {
        let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
        db.list_log_sources(&service_id)?
    };
    system_probe::read_service_logs_from_offsets(&sources, options, &offsets)
}

#[tauri::command]
fn get_operation_history(state: State<'_, AppState>) -> AppResult<Vec<OperationHistoryDto>> {
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    db.list_operation_history()
}

#[tauri::command]
fn get_resource_metrics(
    state: State<'_, AppState>,
    minutes: i64,
) -> AppResult<Vec<ResourceMetricPointDto>> {
    let minutes = minutes.clamp(10, 24 * 60);
    let bucket_seconds = match minutes {
        0..=60 => 1,
        61..=360 => 10,
        _ => 60,
    };
    let since = chrono::Utc::now() - chrono::Duration::minutes(minutes);
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    db.list_resource_metrics(since, bucket_seconds)
}

#[tauri::command]
fn get_system_resource_metrics(
    state: State<'_, AppState>,
    minutes: i64,
) -> AppResult<Vec<ResourceMetricPointDto>> {
    let minutes = minutes.clamp(10, 24 * 60);
    let bucket_seconds = if minutes <= 60 {
        1
    } else if minutes <= 360 {
        10
    } else {
        60
    };
    let requested_since = chrono::Utc::now() - chrono::Duration::minutes(minutes);
    let since = std::cmp::max(requested_since, state.started_at);
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    db.list_system_resource_metrics(since, bucket_seconds)
}

fn sample_system_resource_metric(state: &AppState) -> AppResult<()> {
    let metric = {
        let mut system = state
            .system_metrics
            .lock()
            .map_err(|_| AppError::StatePoisoned)?;
        system.refresh_cpu_usage();
        system.refresh_memory();
        ResourceMetricPointDto {
            service_id: "system".into(),
            cpu_percent: Some(system.global_cpu_usage() as f64),
            memory_bytes: i64::try_from(system.used_memory()).ok(),
            total_memory_bytes: i64::try_from(system.total_memory()).ok(),
            captured_at: chrono::Utc::now(),
        }
    };
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    db.insert_system_resource_metric(&metric)
}

#[tauri::command]
fn get_ports(state: State<'_, AppState>) -> AppResult<Vec<PortBindingDto>> {
    let db = state.db.lock().map_err(|_| AppError::StatePoisoned)?;
    db.list_ports()
}

#[tauri::command]
fn get_app_info(state: State<'_, AppState>) -> AppResult<AppInfoDto> {
    let database_size_bytes = std::fs::metadata(&state.db_path)
        .ok()
        .and_then(|metadata| i64::try_from(metadata.len()).ok())
        .unwrap_or(0);
    Ok(AppInfoDto {
        version: env!("CARGO_PKG_VERSION").into(),
        database_path: state.db_path.to_string_lossy().into_owned(),
        database_size_bytes,
        provider: "Homebrew".into(),
        metric_retention_hours: 25,
        operation_retention_days: 90,
        operation_history_limit: 10_000,
    })
}

#[tauri::command]
fn clear_monitoring_data(state: State<'_, AppState>) -> AppResult<DataCleanupResultDto> {
    let deleted_count = state
        .db
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .clear_monitoring_data()?;
    state
        .runtime_metrics
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .latest
        .clear();
    Ok(DataCleanupResultDto {
        deleted_count: deleted_count as i64,
    })
}

#[tauri::command]
fn clear_operation_history(state: State<'_, AppState>) -> AppResult<DataCleanupResultDto> {
    let deleted_count = state
        .db
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .clear_operation_history()?;
    Ok(DataCleanupResultDto {
        deleted_count: deleted_count as i64,
    })
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|err| Box::new(err) as Box<dyn std::error::Error>)?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("locers.sqlite3");
            let mut database = Database::open(db_path.clone())?;
            database.cleanup_expired_data(chrono::Utc::now())?;
            let started_at = chrono::Utc::now();
            app.manage(AppState {
                db: Mutex::new(database),
                db_path,
                provider: HomebrewProvider::new(CommandRunner::default()),
                log_session_offsets: Mutex::new(HashMap::new()),
                runtime_metrics: Mutex::new(RuntimeMetricsState::new()),
                system_metrics: Mutex::new(sysinfo::System::new_all()),
                started_at,
            });
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut next_sample_at = Instant::now();
                let mut next_maintenance_at = Instant::now() + DATABASE_MAINTENANCE_INTERVAL;
                loop {
                    let state = app_handle.state::<AppState>();
                    let _ = sample_system_resource_metric(&state);
                    if Instant::now() >= next_maintenance_at {
                        if let Ok(mut db) = state.db.lock() {
                            let _ = db.cleanup_expired_data(chrono::Utc::now());
                        }
                        next_maintenance_at = Instant::now() + DATABASE_MAINTENANCE_INTERVAL;
                    }
                    next_sample_at += Duration::from_secs(1);
                    std::thread::sleep(next_sample_at.saturating_duration_since(Instant::now()));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_formula_statuses,
            install_formula,
            upgrade_formula,
            refresh_services,
            refresh_ports,
            refresh_runtime_metrics,
            get_services,
            get_service_detail,
            start_service,
            stop_service,
            restart_service,
            remove_service,
            get_service_logs,
            get_operation_history,
            get_resource_metrics,
            get_system_resource_metrics,
            get_ports,
            get_app_info,
            clear_monitoring_data,
            clear_operation_history
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Locers");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_preview_is_argv_safe() {
        let provider = HomebrewProvider::new(CommandRunner::default());
        let preview = provider.command_preview("restart", "postgresql@16");
        assert_eq!(
            preview,
            vec!["brew", "services", "restart", "postgresql@16"]
        );
    }

    #[test]
    fn remove_command_preview_is_argv_safe() {
        let provider = HomebrewProvider::new(CommandRunner::default());
        let preview = provider.command_preview("remove", "postgresql@16");
        assert_eq!(
            preview,
            vec!["brew", "uninstall", "--formula", "postgresql@16"]
        );
    }
}
