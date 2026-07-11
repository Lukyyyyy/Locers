use serde::Serialize;
use thiserror::Error;

use crate::models::OperationHistoryDto;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "detail")]
pub enum AppError {
    #[error("database error: {0}")]
    Database(String),
    #[error("command failed: {0}")]
    Command(String),
    #[error("homebrew is not available at a known path")]
    BrewNotFound,
    #[error("service not found: {0}")]
    ServiceNotFound(String),
    #[error("operation failed: {message}")]
    OperationFailed {
        message: String,
        operation: Option<Box<OperationHistoryDto>>,
    },
    #[error("log source is unavailable: {0}")]
    LogUnavailable(String),
    #[error("application state lock is poisoned")]
    StatePoisoned,
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        AppError::Database(value.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Command(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Command(value.to_string())
    }
}
