use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::Path,
    process::Command,
};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use chrono::Utc;
use sysinfo::{Pid, ProcessesToUpdate, System};

use crate::{
    error::{AppError, AppResult},
    models::{
        LogReadOptionsDto, LogReadResultDto, LogSourceDto, ManagedService, PortBindingDto,
        ServiceSnapshot, ServiceStatus,
    },
};

pub fn scan_listening_ports() -> AppResult<Vec<PortBindingDto>> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
        .output()
        .or_else(|_| {
            Command::new("lsof")
                .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
                .output()
        })
        .map_err(|err| AppError::Command(format!("failed to run lsof: {err}")))?;

    if !output.status.success() {
        return Err(AppError::Command(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    let mut bindings = parse_lsof_output(&String::from_utf8_lossy(&output.stdout));
    restore_process_names(&mut bindings);
    Ok(bindings)
}

/// `lsof` truncates its COMMAND column by bytes. On macOS this can cut a
/// multi-byte process name in the middle and produce replacement characters.
/// Resolve the full process name by PID instead of displaying that truncated
/// column; retain the lsof value when the process exits between both probes.
fn restore_process_names(bindings: &mut [PortBindingDto]) {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    for binding in bindings {
        let Some(process) = system.process(Pid::from(binding.pid as usize)) else {
            continue;
        };
        let process_name = process.name().to_string_lossy();
        if !process_name.is_empty() {
            binding.process_name = process_name.into_owned();
        }
    }
}

pub struct RuntimeMetricsCollector {
    system: System,
    previous_process_starts: HashMap<i64, u64>,
}

impl RuntimeMetricsCollector {
    pub fn new() -> Self {
        Self {
            system: System::new(),
            previous_process_starts: HashMap::new(),
        }
    }

    pub fn collect(
        &mut self,
        services: &[ManagedService],
        ports: &[PortBindingDto],
    ) -> Vec<ServiceSnapshot> {
        self.system.refresh_processes(ProcessesToUpdate::All, true);
        let snapshots = services
            .iter()
            .map(|service| {
                snapshot_for_service_with_system(
                    service,
                    ports,
                    &self.system,
                    &self.previous_process_starts,
                )
            })
            .collect();
        self.previous_process_starts = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| (pid.as_u32() as i64, process.start_time()))
            .collect();
        snapshots
    }
}

impl Default for RuntimeMetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
fn snapshot_for_service(service: &ManagedService, ports: &[PortBindingDto]) -> ServiceSnapshot {
    snapshot_for_service_with_system(service, ports, &System::new(), &HashMap::new())
}

fn snapshot_for_service_with_system(
    service: &ManagedService,
    ports: &[PortBindingDto],
    system: &System,
    previous_process_starts: &HashMap<i64, u64>,
) -> ServiceSnapshot {
    if service.status != ServiceStatus::Running {
        return ServiceSnapshot {
            service_id: service.id.clone(),
            status: service.status.clone(),
            pid: None,
            cpu_percent: None,
            memory_bytes: None,
            uptime_seconds: None,
            error_message: None,
            captured_at: Utc::now(),
        };
    }

    let process_pid = find_matching_process_pid(service, system);
    let matching_ports: Vec<&PortBindingDto> = ports
        .iter()
        .filter(|port| {
            port.service_id.as_deref() == Some(service.id.as_str())
                || Some(port.pid) == process_pid
                || service_matches_text(service, port.process_name.as_str())
        })
        .collect();
    let pid = process_pid.or_else(|| matching_ports.first().map(|port| port.pid));
    let process = pid.and_then(|value| system.process(Pid::from(value as usize)));
    let cpu_sample_ready = pid.zip(process).is_some_and(|(pid, process)| {
        previous_process_starts.get(&pid) == Some(&process.start_time())
    });
    let process_tree = pid
        .map(|root_pid| process_tree_pids(root_pid, system))
        .unwrap_or_default();
    let system_uptime = System::uptime();

    ServiceSnapshot {
        service_id: service.id.clone(),
        status: service.status.clone(),
        pid,
        cpu_percent: cpu_sample_ready.then(|| {
            process_tree
                .iter()
                .filter_map(|pid| system.process(*pid))
                .map(|process| process.cpu_usage() as f64)
                .sum()
        }),
        memory_bytes: process.map(|_| {
            process_tree
                .iter()
                .filter_map(|pid| system.process(*pid))
                .map(|process| process.memory() as i64)
                .sum()
        }),
        uptime_seconds: process.and_then(|process| {
            validated_process_uptime(process.start_time(), process.run_time(), system_uptime)
        }),
        error_message: None,
        captured_at: Utc::now(),
    }
}

fn validated_process_uptime(
    process_start_time: u64,
    process_run_time: u64,
    system_uptime: u64,
) -> Option<i64> {
    // On macOS, sysinfo can retain a process discovered through its fallback
    // path with start_time == 0. Its next refresh then reports UNIX epoch
    // seconds as run_time, which renders as roughly 20,000 days.
    if process_start_time == 0 || process_run_time > system_uptime.saturating_add(5) {
        return None;
    }
    i64::try_from(process_run_time).ok()
}

fn process_tree_pids(root_pid: i64, system: &System) -> HashSet<Pid> {
    let root = Pid::from(root_pid as usize);
    if system.process(root).is_none() {
        return HashSet::new();
    }

    let mut tree = HashSet::from([root]);
    loop {
        let previous_len = tree.len();
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| tree.contains(&parent))
            {
                tree.insert(*pid);
            }
        }
        if tree.len() == previous_len {
            return tree;
        }
    }
}

#[cfg(test)]
pub fn read_service_logs(
    sources: &[LogSourceDto],
    options: LogReadOptionsDto,
) -> AppResult<LogReadResultDto> {
    read_service_logs_from_offsets(sources, options, &HashMap::new())
}

pub fn capture_log_offsets(sources: &[LogSourceDto]) -> HashMap<String, u64> {
    sources
        .iter()
        .map(|source| {
            let length = std::fs::metadata(source.path.as_str())
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            (source.path.clone(), length)
        })
        .collect()
}

pub fn read_service_logs_from_offsets(
    sources: &[LogSourceDto],
    options: LogReadOptionsDto,
    offsets: &HashMap<String, u64>,
) -> AppResult<LogReadResultDto> {
    let max_lines = options.max_lines.unwrap_or(300).clamp(1, 2000);
    let query = options.query.unwrap_or_default().to_lowercase();
    let mut seen_paths = HashSet::new();
    let readable_sources = sources
        .iter()
        .filter(|source| {
            (source.readable || Path::new(source.path.as_str()).is_file())
                && seen_paths.insert(source.path.clone())
        })
        .collect::<Vec<_>>();
    if readable_sources.is_empty() {
        return Ok(LogReadResultDto {
            source: None,
            lines: Vec::new(),
            error: Some("No readable log source was found for this service.".to_string()),
        });
    }

    let mut ring = VecDeque::with_capacity(max_lines);
    for source in &readable_sources {
        if !Path::new(source.path.as_str()).exists() {
            continue;
        }
        let mut file = File::open(source.path.as_str())
            .map_err(|err| AppError::LogUnavailable(format!("{}: {err}", source.path)))?;
        let file_length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        let offset = offsets.get(source.path.as_str()).copied().unwrap_or(0);
        // A smaller file means it was truncated or rotated after the service started.
        file.seek(SeekFrom::Start(if offset <= file_length {
            offset
        } else {
            0
        }))?;
        let reader = BufReader::new(file);
        for line in reader.lines() {
            let line = line.unwrap_or_default();
            if !query.is_empty() && !line.to_lowercase().contains(query.as_str()) {
                continue;
            }
            ring.push_back(line);
            if ring.len() > max_lines {
                ring.pop_front();
            }
        }
    }
    Ok(LogReadResultDto {
        source: (readable_sources.len() == 1).then(|| (*readable_sources[0]).clone()),
        lines: ring.into_iter().collect(),
        error: None,
    })
}

fn parse_lsof_output(output: &str) -> Vec<PortBindingDto> {
    let mut bindings = Vec::new();
    let mut seen = HashSet::new();
    for line in output.lines().skip(1) {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 9 {
            continue;
        }
        let process_name = columns[0].to_string();
        let pid = columns[1].parse::<i64>().unwrap_or_default();
        let name = columns[8..].join(" ");
        let Some((address, port)) = parse_address_port(name.as_str()) else {
            continue;
        };
        let key = format!("{pid}:{port}");
        if seen.insert(key) {
            bindings.push(PortBindingDto {
                service_id: None,
                pid,
                port,
                protocol: "tcp".to_string(),
                address,
                process_name,
            });
        }
    }
    bindings
}

fn parse_address_port(input: &str) -> Option<(String, i64)> {
    let listen_part = input.split(" (LISTEN)").next().unwrap_or(input);
    let mut parts = listen_part.rsplitn(2, ':');
    let port = parts.next()?.parse::<i64>().ok()?;
    let address = parts.next().unwrap_or("*").to_string();
    Some((address, port))
}

pub fn attach_ports_to_services(
    services: &[ManagedService],
    ports: &[PortBindingDto],
) -> HashMap<String, Vec<PortBindingDto>> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let service_pids: HashMap<String, HashSet<i64>> = services
        .iter()
        .map(|service| {
            let pids = matching_process_pids(service, &system)
                .into_iter()
                .collect::<HashSet<_>>();
            (service.id.clone(), pids)
        })
        .collect();

    services
        .iter()
        .map(|service| {
            if service.status != ServiceStatus::Running {
                return (service.id.clone(), Vec::new());
            }

            let pids = service_pids.get(service.id.as_str());
            let matches = ports
                .iter()
                .filter(|port| {
                    pids.is_some_and(|pids| pids.contains(&port.pid))
                        || service_matches_text(service, port.process_name.as_str())
                })
                .cloned()
                .map(|mut port| {
                    port.service_id = Some(service.id.clone());
                    port
                })
                .collect();
            (service.id.clone(), matches)
        })
        .collect()
}

fn find_matching_process_pid(service: &ManagedService, system: &System) -> Option<i64> {
    launchd_pid_for_service(service)
        .filter(|pid| system.process(Pid::from(*pid as usize)).is_some())
        .or_else(|| {
            matching_process_pids_by_text(service, system)
                .into_iter()
                .next()
        })
}

fn matching_process_pids(service: &ManagedService, system: &System) -> Vec<i64> {
    let mut pids = launchd_pid_for_service(service)
        .into_iter()
        .collect::<Vec<_>>();
    pids.extend(matching_process_pids_by_text(service, system));
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn matching_process_pids_by_text(service: &ManagedService, system: &System) -> Vec<i64> {
    system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let command = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let haystack = format!("{} {}", process.name().to_string_lossy(), command);
            if service_matches_text(service, haystack.as_str()) {
                Some(pid.as_u32() as i64)
            } else {
                None
            }
        })
        .collect()
}

fn launchd_pid_for_service(service: &ManagedService) -> Option<i64> {
    let label = service
        .plist_path
        .as_deref()
        .and_then(read_launchd_label)
        .unwrap_or_else(|| format!("homebrew.mxcl.{}", service.service_name));
    let uid = current_uid()?;
    let target = format!("gui/{uid}/{label}");
    let output = Command::new("/bin/launchctl")
        .args(["print", target.as_str()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_launchctl_pid(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(unix)]
fn current_uid() -> Option<u32> {
    dirs::home_dir()?
        .metadata()
        .ok()
        .map(|metadata| metadata.uid())
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

fn read_launchd_label(plist_path: &str) -> Option<String> {
    let plist = std::fs::read_to_string(plist_path).ok()?;
    let after_key = plist.split("<key>Label</key>").nth(1)?;
    let start = after_key.find("<string>")? + "<string>".len();
    let end = after_key[start..].find("</string>")? + start;
    Some(after_key[start..end].to_string())
}

fn parse_launchctl_pid(output: &str) -> Option<i64> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("pid = ")
            .and_then(|pid| pid.trim_end_matches(';').parse().ok())
    })
}

fn service_matches_text(service: &ManagedService, text: &str) -> bool {
    let haystack = text.to_lowercase();
    service_match_terms(service)
        .iter()
        .any(|term| haystack.contains(term.as_str()))
}

fn service_match_terms(service: &ManagedService) -> Vec<String> {
    let mut terms = HashSet::new();
    for value in [&service.formula, &service.service_name] {
        add_service_terms(value, &mut terms);
    }
    terms.into_iter().filter(|term| term.len() >= 3).collect()
}

fn add_service_terms(value: &str, terms: &mut HashSet<String>) {
    let lower = value.to_lowercase();
    terms.insert(lower.clone());
    for part in lower.split(['@', '-', '_', '.', '/']) {
        if part.len() >= 3 {
            terms.insert(part.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_listening_ports() {
        let output = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\npostgres 123 luky  7u  IPv6 0xabc 0t0 TCP *:5432 (LISTEN)\nredis    456 luky  6u  IPv4 0xdef 0t0 TCP 127.0.0.1:6379 (LISTEN)\n";
        let ports = parse_lsof_output(output);
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].process_name, "postgres");
        assert_eq!(ports[0].port, 5432);
        assert_eq!(ports[1].address, "127.0.0.1");
    }

    #[test]
    fn collapses_duplicate_listeners_for_same_pid_and_port() {
        let output = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nminio 59765 luky  10u  IPv4 0xabc 0t0 TCP 127.0.0.1:9000 (LISTEN)\nminio 59765 luky  11u  IPv6 0xdef 0t0 TCP *:9000 (LISTEN)\nminio 59765 luky  12u  IPv6 0xghi 0t0 TCP [::1]:9000 (LISTEN)\n";
        let ports = parse_lsof_output(output);

        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port, 9000);
        assert_eq!(ports[0].address, "127.0.0.1");
    }

    #[test]
    fn restores_process_name_from_pid_when_lsof_name_is_corrupted() {
        let pid = std::process::id() as i64;
        let mut ports = vec![PortBindingDto {
            service_id: None,
            pid,
            port: 65_535,
            protocol: "tcp".to_string(),
            address: "127.0.0.1".to_string(),
            process_name: "�\\x81�".to_string(),
        }];

        restore_process_names(&mut ports);

        assert!(!ports[0].process_name.contains('�'));
        assert!(!ports[0].process_name.is_empty());
    }

    #[test]
    fn skips_runtime_snapshot_for_error_services() {
        let service = ManagedService {
            id: "svc-es".to_string(),
            provider: "homebrew".to_string(),
            service_name: "elasticsearch-full".to_string(),
            formula: "elasticsearch-full".to_string(),
            status: crate::models::ServiceStatus::Error,
            user: None,
            plist_path: None,
            file_path: None,
            favorite: false,
            note: None,
            provider_metadata: serde_json::json!({}),
            updated_at: Utc::now(),
        };

        let snapshot = snapshot_for_service(&service, &[]);

        assert_eq!(snapshot.status, crate::models::ServiceStatus::Error);
        assert_eq!(snapshot.pid, None);
        assert_eq!(snapshot.cpu_percent, None);
        assert_eq!(snapshot.memory_bytes, None);
    }

    #[test]
    fn service_terms_include_split_formula_names() {
        let service = ManagedService {
            id: "svc".to_string(),
            provider: "homebrew".to_string(),
            service_name: "elasticsearch-full".to_string(),
            formula: "elasticsearch-full".to_string(),
            status: crate::models::ServiceStatus::Running,
            user: None,
            plist_path: None,
            file_path: None,
            favorite: false,
            note: None,
            provider_metadata: serde_json::json!({}),
            updated_at: Utc::now(),
        };

        let terms = service_match_terms(&service);
        assert!(terms.contains(&"elasticsearch-full".to_string()));
        assert!(terms.contains(&"elasticsearch".to_string()));
    }

    #[test]
    fn attaches_java_wrapped_service_ports_by_matching_command_pid() {
        let service = ManagedService {
            id: "svc-kafka".to_string(),
            provider: "homebrew".to_string(),
            service_name: "kafka".to_string(),
            formula: "kafka".to_string(),
            status: crate::models::ServiceStatus::Running,
            user: None,
            plist_path: None,
            file_path: None,
            favorite: false,
            note: None,
            provider_metadata: serde_json::json!({}),
            updated_at: Utc::now(),
        };

        assert!(service_matches_text(
            &service,
            "java -cp /opt/homebrew/Cellar/kafka/libs kafka.Kafka"
        ));
        assert!(!service_matches_text(&service, "java -jar unrelated.jar"));
    }

    #[test]
    fn snapshot_uses_attached_port_service_id_for_wrapped_processes() {
        let service = ManagedService {
            id: "svc-kafka".to_string(),
            provider: "homebrew".to_string(),
            service_name: "kafka".to_string(),
            formula: "kafka".to_string(),
            status: crate::models::ServiceStatus::Running,
            user: None,
            plist_path: None,
            file_path: None,
            favorite: false,
            note: None,
            provider_metadata: serde_json::json!({}),
            updated_at: Utc::now(),
        };
        let ports = vec![PortBindingDto {
            service_id: Some("svc-kafka".to_string()),
            pid: 4242,
            port: 9092,
            protocol: "tcp".to_string(),
            address: "127.0.0.1".to_string(),
            process_name: "java".to_string(),
        }];

        let snapshot = snapshot_for_service(&service, &ports);

        assert_eq!(snapshot.pid, Some(4242));
    }

    #[test]
    fn cpu_usage_becomes_available_after_the_second_process_sample() {
        let service = ManagedService {
            id: "svc-sampler-test".to_string(),
            provider: "homebrew".to_string(),
            service_name: "codexmetricsregressionxyz".to_string(),
            formula: "codexmetricsregressionxyz".to_string(),
            status: crate::models::ServiceStatus::Running,
            user: None,
            plist_path: None,
            file_path: None,
            favorite: false,
            note: None,
            provider_metadata: serde_json::json!({}),
            updated_at: Utc::now(),
        };
        let ports = vec![PortBindingDto {
            service_id: Some(service.id.clone()),
            pid: std::process::id() as i64,
            port: 65_535,
            protocol: "tcp".to_string(),
            address: "127.0.0.1".to_string(),
            process_name: "sampler-test-process".to_string(),
        }];
        let mut collector = RuntimeMetricsCollector::new();

        let first = collector.collect(std::slice::from_ref(&service), &ports);
        assert_eq!(first[0].pid, Some(std::process::id() as i64));
        assert_eq!(first[0].cpu_percent, None);
        assert!(first[0].memory_bytes.is_some());

        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        let second = collector.collect(&[service], &ports);
        assert!(second[0].cpu_percent.is_some());
    }

    #[test]
    fn rejects_epoch_seconds_reported_as_process_uptime() {
        assert_eq!(validated_process_uptime(0, 1_783_641_600, 86_400), None);
        assert_eq!(
            validated_process_uptime(1_783_600_000, 1_783_641_600, 86_400),
            None
        );
    }

    #[test]
    fn accepts_process_uptime_within_system_uptime() {
        assert_eq!(
            validated_process_uptime(1_783_600_000, 3_720, 86_400),
            Some(3_720)
        );
    }

    #[test]
    fn parses_pid_from_launchctl_print_output() {
        let output = r#"
        homebrew.mxcl.kafka = {
            active count = 1
            state = running
            pid = 47123
        }
        "#;

        assert_eq!(parse_launchctl_pid(output), Some(47123));
    }

    #[test]
    fn reads_all_unique_log_sources() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let stdout_path = directory.path().join("stdout.log");
        let stderr_path = directory.path().join("stderr.log");
        std::fs::write(&stdout_path, "service starting\nservice ready\n").expect("stdout log");
        std::fs::write(&stderr_path, "service warning\n").expect("stderr log");
        let sources = vec![
            LogSourceDto {
                id: None,
                service_id: "svc".into(),
                path: stdout_path.to_string_lossy().into_owned(),
                source_type: "stdout".into(),
                readable: true,
            },
            LogSourceDto {
                id: None,
                service_id: "svc".into(),
                path: stderr_path.to_string_lossy().into_owned(),
                source_type: "stderr".into(),
                readable: true,
            },
            LogSourceDto {
                id: None,
                service_id: "svc".into(),
                path: stdout_path.to_string_lossy().into_owned(),
                source_type: "duplicate".into(),
                readable: true,
            },
        ];

        let result = read_service_logs(
            &sources,
            LogReadOptionsDto {
                max_lines: Some(20),
                query: None,
            },
        )
        .expect("logs");

        assert_eq!(
            result.lines,
            vec!["service starting", "service ready", "service warning"]
        );
    }

    #[test]
    fn reads_only_lines_appended_after_log_session_started() {
        use std::io::Write;

        let directory = tempfile::tempdir().expect("temporary directory");
        let log_path = directory.path().join("service.log");
        std::fs::write(&log_path, "old run\n").expect("old log");
        let sources = vec![LogSourceDto {
            id: None,
            service_id: "svc".into(),
            path: log_path.to_string_lossy().into_owned(),
            source_type: "stdout".into(),
            readable: true,
        }];
        let offsets = capture_log_offsets(&sources);
        let mut log = std::fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .expect("open log");
        writeln!(log, "current run").expect("append log");

        let result = read_service_logs_from_offsets(
            &sources,
            LogReadOptionsDto {
                max_lines: Some(20),
                query: None,
            },
            &offsets,
        )
        .expect("session logs");

        assert_eq!(result.lines, vec!["current run"]);
    }
}
