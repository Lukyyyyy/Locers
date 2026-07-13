use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use std::time::Duration;

use crate::{
    command_runner::{CommandOutput, CommandRunner},
    error::AppResult,
    models::{DiscoveredService, LogSourceDto, ManagedService, ServiceStatus},
};

pub trait ServiceProvider {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn discover(&self) -> AppResult<Vec<DiscoveredService>>;
    fn start(&self, service_name: &str) -> AppResult<CommandOutput>;
    fn stop(&self, service_name: &str) -> AppResult<CommandOutput>;
    fn restart(&self, service_name: &str) -> AppResult<CommandOutput>;
    fn uninstall(&self, formula: &str) -> AppResult<CommandOutput>;
    fn infer_log_sources(&self, service: &ManagedService) -> Vec<LogSourceDto>;
}

#[derive(Debug, Clone)]
pub struct HomebrewProvider {
    runner: CommandRunner,
}

#[derive(Debug, Deserialize)]
struct BrewServiceRow {
    name: String,
    status: Option<String>,
    user: Option<String>,
    file: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrewOutdatedResponse {
    #[serde(default)]
    formulae: Vec<BrewOutdatedFormula>,
}

#[derive(Debug, Deserialize)]
struct BrewOutdatedFormula {
    name: String,
    #[serde(default)]
    installed_versions: Vec<String>,
    current_version: Option<String>,
}

impl HomebrewProvider {
    pub fn new(runner: CommandRunner) -> Self {
        Self { runner }
    }

    pub fn command_preview(&self, operation_type: &str, service_name: &str) -> Vec<String> {
        if operation_type == "remove" {
            return vec![
                "brew".to_string(),
                "uninstall".to_string(),
                "--formula".to_string(),
                service_name.to_string(),
            ];
        }
        vec![
            "brew".to_string(),
            "services".to_string(),
            operation_type.to_string(),
            service_name.to_string(),
        ]
    }

    pub fn run_operation(
        &self,
        operation_type: &str,
        service_name: &str,
    ) -> AppResult<CommandOutput> {
        match operation_type {
            "start" => self.start(service_name),
            "stop" => self.stop(service_name),
            "restart" => self.restart(service_name),
            _ => unreachable!("unsupported operation"),
        }
    }

    pub fn installed_formulae(&self) -> AppResult<Vec<(String, String)>> {
        let brew = CommandRunner::find_brew()?;
        let output = self
            .runner
            .run(&brew, &["list", "--formula", "--versions"])?;
        if output.exit_code != 0 {
            return Err(crate::error::AppError::Command(format!(
                "Homebrew installed formula check failed: {}",
                output.stderr.trim()
            )));
        }
        Ok(Self::parse_installed_formulae(&output.stdout))
    }

    fn parse_installed_formulae(input: &str) -> Vec<(String, String)> {
        input
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let formula = fields.next()?;
                // Homebrew may retain multiple installed keg versions. The last
                // value is the active/newest one, matching the previous status UI.
                let version = fields.last()?;
                Some((formula.to_string(), version.to_string()))
            })
            .collect()
    }

    pub fn install(&self, formula: &str) -> AppResult<CommandOutput> {
        let brew = CommandRunner::find_brew()?;
        self.runner.run_with_timeout(
            &brew,
            &["install", "--formula", formula],
            Duration::from_secs(15 * 60),
        )
    }

    pub fn outdated_formulae(&self) -> AppResult<Vec<(String, Option<String>, Option<String>)>> {
        let brew = CommandRunner::find_brew()?;
        let output = self
            .runner
            .run(&brew, &["outdated", "--formula", "--json=v2"])?;
        if output.exit_code != 0 {
            return Err(crate::error::AppError::Command(format!(
                "Homebrew outdated check failed: {}",
                output.stderr.trim()
            )));
        }
        Self::parse_outdated_json(&output.stdout)
    }

    fn parse_outdated_json(
        input: &str,
    ) -> AppResult<Vec<(String, Option<String>, Option<String>)>> {
        let response: BrewOutdatedResponse = serde_json::from_str(input)?;
        Ok(response
            .formulae
            .into_iter()
            .map(|item| {
                let installed = item.installed_versions.last().cloned();
                (item.name, installed, item.current_version)
            })
            .collect())
    }

    pub fn upgrade(&self, formula: &str) -> AppResult<CommandOutput> {
        let brew = CommandRunner::find_brew()?;
        self.runner.run_with_timeout(
            &brew,
            &["upgrade", "--formula", formula],
            Duration::from_secs(15 * 60),
        )
    }

    pub fn parse_services_json(input: &str) -> AppResult<Vec<DiscoveredService>> {
        let rows: Vec<BrewServiceRow> = serde_json::from_str(input)?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let status = map_brew_status(row.status.as_deref());
                DiscoveredService {
                    provider: "homebrew".to_string(),
                    formula: row.name.clone(),
                    service_name: row.name.clone(),
                    status,
                    user: row.user.clone().filter(|value| !value.is_empty()),
                    plist_path: row.file.clone().filter(|value| value.ends_with(".plist")),
                    file_path: row.file.clone(),
                    provider_metadata: json!({
                        "source": "brew services list --json",
                        "raw_status": row.status,
                        "file": row.file,
                    }),
                }
            })
            .collect())
    }
}

impl ServiceProvider for HomebrewProvider {
    fn id(&self) -> &'static str {
        "homebrew"
    }

    fn display_name(&self) -> &'static str {
        "Homebrew"
    }

    fn discover(&self) -> AppResult<Vec<DiscoveredService>> {
        let brew = CommandRunner::find_brew()?;
        let output = self.runner.run(&brew, &["services", "list", "--json"])?;
        Self::parse_services_json(&output.stdout)
    }

    fn start(&self, service_name: &str) -> AppResult<CommandOutput> {
        let brew = CommandRunner::find_brew()?;
        self.runner.run(&brew, &["services", "start", service_name])
    }

    fn stop(&self, service_name: &str) -> AppResult<CommandOutput> {
        let brew = CommandRunner::find_brew()?;
        self.runner.run(&brew, &["services", "stop", service_name])
    }

    fn restart(&self, service_name: &str) -> AppResult<CommandOutput> {
        let brew = CommandRunner::find_brew()?;
        self.runner
            .run(&brew, &["services", "restart", service_name])
    }

    fn uninstall(&self, formula: &str) -> AppResult<CommandOutput> {
        let brew = CommandRunner::find_brew()?;
        self.runner.run(&brew, &["uninstall", "--formula", formula])
    }

    fn infer_log_sources(&self, service: &ManagedService) -> Vec<LogSourceDto> {
        let mut paths = Vec::new();
        if let Some(plist_path) = &service.plist_path {
            paths.extend(
                extract_plist_log_paths(plist_path)
                    .into_iter()
                    .map(|path| (path, "launchd-plist")),
            );
        }
        if let Some(home) = dirs::home_dir() {
            paths.push((
                home.join("Library/Logs/Homebrew")
                    .join(format!("{}.log", service.formula)),
                "homebrew-inferred",
            ));
        }
        paths.push((
            format!("/opt/homebrew/var/log/{}.log", service.formula).into(),
            "homebrew-inferred",
        ));
        paths.push((
            format!("/usr/local/var/log/{}.log", service.formula).into(),
            "homebrew-inferred",
        ));

        let mut seen = HashSet::new();
        paths
            .into_iter()
            .filter(|(path, _)| seen.insert(path.clone()))
            .map(|(path, source_type)| {
                let path_string = path.to_string_lossy().to_string();
                LogSourceDto {
                    id: None,
                    service_id: service.id.clone(),
                    path: path_string.clone(),
                    source_type: source_type.to_string(),
                    readable: std::fs::File::open(path_string).is_ok(),
                }
            })
            .collect()
    }
}

fn extract_plist_log_paths(plist_path: &str) -> Vec<std::path::PathBuf> {
    let Ok(plist) = std::fs::read_to_string(plist_path) else {
        return Vec::new();
    };
    ["StandardOutPath", "StandardErrorPath"]
        .iter()
        .filter_map(|key| extract_plist_string_after_key(plist.as_str(), key))
        .map(std::path::PathBuf::from)
        .collect()
}

fn extract_plist_string_after_key(plist: &str, key: &str) -> Option<String> {
    let key_tag = format!("<key>{key}</key>");
    let after_key = plist.split(key_tag.as_str()).nth(1)?;
    let start = after_key.find("<string>")? + "<string>".len();
    let end = after_key[start..].find("</string>")? + start;
    Some(
        after_key[start..end]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'"),
    )
}

fn map_brew_status(status: Option<&str>) -> ServiceStatus {
    match status.unwrap_or_default().to_lowercase().as_str() {
        "started" | "running" => ServiceStatus::Running,
        "stopped" | "none" => ServiceStatus::Stopped,
        "error" | "failed" => ServiceStatus::Error,
        _ => ServiceStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_homebrew_services_json() {
        let json = r#"[
          {"name":"postgresql@16","status":"started","user":"luky","file":"/Users/luky/Library/LaunchAgents/homebrew.mxcl.postgresql@16.plist"},
          {"name":"redis","status":"stopped","user":null,"file":null},
          {"name":"mysql","status":"error","user":"luky","file":"/tmp/mysql.plist"}
        ]"#;

        let services = HomebrewProvider::parse_services_json(json).expect("parsed services");

        assert_eq!(services.len(), 3);
        assert_eq!(services[0].service_name, "postgresql@16");
        assert_eq!(services[0].status, ServiceStatus::Running);
        assert_eq!(services[1].status, ServiceStatus::Stopped);
        assert_eq!(services[2].status, ServiceStatus::Error);
        assert_eq!(
            services[0].plist_path.as_deref(),
            Some("/Users/luky/Library/LaunchAgents/homebrew.mxcl.postgresql@16.plist")
        );
    }

    #[test]
    fn maps_unknown_status_without_crashing() {
        let json = r#"[{"name":"custom","status":"weird","user":"","file":"/tmp/custom.txt"}]"#;
        let services = HomebrewProvider::parse_services_json(json).expect("parsed services");
        assert_eq!(services[0].status, ServiceStatus::Unknown);
        assert_eq!(services[0].user, None);
        assert_eq!(services[0].plist_path, None);
    }

    #[test]
    fn maps_homebrew_error_statuses_to_error_display_state() {
        let json = r#"[
          {"name":"elasticsearch-full","status":"error","user":"luky","file":"/tmp/elasticsearch.plist"},
          {"name":"kafka","status":"failed","user":"luky","file":"/tmp/kafka.plist"}
        ]"#;

        let services = HomebrewProvider::parse_services_json(json).expect("parsed services");

        assert_eq!(services[0].status, ServiceStatus::Error);
        assert_eq!(services[1].status, ServiceStatus::Error);
    }

    #[test]
    fn parses_outdated_formula_versions() {
        let json = r#"{
          "formulae": [{
            "name": "redis",
            "installed_versions": ["8.8.0"],
            "current_version": "8.8.1",
            "pinned": false
          }],
          "casks": []
        }"#;

        let formulae = HomebrewProvider::parse_outdated_json(json).expect("outdated formulae");
        assert_eq!(
            formulae,
            vec![(
                "redis".to_string(),
                Some("8.8.0".to_string()),
                Some("8.8.1".to_string())
            )]
        );
    }

    #[test]
    fn parses_installed_formulae_in_one_batch() {
        let installed =
            HomebrewProvider::parse_installed_formulae("mysql 9.6.0_3\nredis 8.8.0 8.8.1\n\n");
        assert_eq!(
            installed,
            vec![
                ("mysql".to_string(), "9.6.0_3".to_string()),
                ("redis".to_string(), "8.8.1".to_string())
            ]
        );
    }

    #[test]
    fn extracts_launchd_log_paths_from_plist() {
        let plist = r#"
        <plist>
          <dict>
            <key>StandardOutPath</key>
            <string>/tmp/kafka.out.log</string>
            <key>StandardErrorPath</key>
            <string>/tmp/kafka.err.log</string>
          </dict>
        </plist>
        "#;

        assert_eq!(
            extract_plist_string_after_key(plist, "StandardOutPath").as_deref(),
            Some("/tmp/kafka.out.log")
        );
        assert_eq!(
            extract_plist_string_after_key(plist, "StandardErrorPath").as_deref(),
            Some("/tmp/kafka.err.log")
        );
    }
}
