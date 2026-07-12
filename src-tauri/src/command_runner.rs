use std::{
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: i64,
}

#[derive(Debug, Clone)]
pub struct CommandRunner {
    timeout: Duration,
}

impl Default for CommandRunner {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
        }
    }
}

impl CommandRunner {
    #[cfg(test)]
    pub fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }

    pub fn run(&self, program: &str, args: &[&str]) -> AppResult<CommandOutput> {
        self.run_with_timeout(program, args, self.timeout)
    }

    pub fn run_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        timeout: Duration,
    ) -> AppResult<CommandOutput> {
        let started_at = Instant::now();
        let mut child = Command::new(program)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| AppError::Command(format!("failed to spawn {program}: {err}")))?;

        loop {
            if child.try_wait()?.is_some() {
                let output = child.wait_with_output()?;
                return Ok(CommandOutput {
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                    exit_code: output.status.code().unwrap_or(-1),
                    duration_ms: started_at.elapsed().as_millis() as i64,
                });
            }
            if started_at.elapsed() > timeout {
                let _ = child.kill();
                return Err(AppError::Command(format!(
                    "{program} timed out after {}ms",
                    timeout.as_millis()
                )));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn find_brew() -> AppResult<String> {
        let candidates = [
            "/opt/homebrew/bin/brew",
            "/usr/local/bin/brew",
            "/home/linuxbrew/.linuxbrew/bin/brew",
        ];
        for candidate in candidates {
            if PathBuf::from(candidate).exists() {
                return Ok(candidate.to_string());
            }
        }
        Err(AppError::BrewNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_stdout_stderr_and_exit_code() {
        let runner = CommandRunner::with_timeout(Duration::from_secs(3));
        let output = runner
            .run("/bin/sh", &["-c", "printf ok && printf warn >&2 && exit 7"])
            .expect("command output");
        assert_eq!(output.stdout, "ok");
        assert_eq!(output.stderr, "warn");
        assert_eq!(output.exit_code, 7);
    }

    #[test]
    fn times_out_long_running_processes() {
        let runner = CommandRunner::with_timeout(Duration::from_millis(50));
        let error = runner.run("/bin/sleep", &["1"]).expect_err("timeout");
        assert!(error.to_string().contains("timed out"));
    }
}
