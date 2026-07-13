use std::{
    io::Read,
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

        // Drain both pipes while the process runs. Waiting before reading can
        // deadlock commands with large JSON responses once an OS pipe fills.
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let stdout_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).map(|_| bytes)
        });
        let stderr_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).map(|_| bytes)
        });

        loop {
            if let Some(status) = child.try_wait()? {
                let stdout = stdout_reader
                    .join()
                    .map_err(|_| AppError::Command("stdout reader panicked".into()))??;
                let stderr = stderr_reader
                    .join()
                    .map_err(|_| AppError::Command("stderr reader panicked".into()))??;
                return Ok(CommandOutput {
                    stdout: String::from_utf8_lossy(&stdout).to_string(),
                    stderr: String::from_utf8_lossy(&stderr).to_string(),
                    exit_code: status.code().unwrap_or(-1),
                    duration_ms: started_at.elapsed().as_millis() as i64,
                });
            }
            if started_at.elapsed() > timeout {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
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

    #[test]
    fn drains_output_larger_than_an_os_pipe() {
        let runner = CommandRunner::with_timeout(Duration::from_secs(3));
        let output = runner
            .run(
                "/bin/sh",
                &["-c", "dd if=/dev/zero bs=1024 count=256 2>/dev/null"],
            )
            .expect("large output");
        assert_eq!(output.stdout.len(), 256 * 1024);
    }
}
