use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionMode { Dictation, Thinking }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionState { Idle, Starting, Listening, Finalizing, Cleaning, Completed, Synthesizing, Failed }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub mode: SessionMode,
    pub state: SessionState,
    pub title: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
}

impl Session {
    pub fn new(mode: SessionMode, started_at_ms: i64) -> Self {
        Self { id: Uuid::new_v4(), mode, state: SessionState::Starting, title: None, started_at_ms, ended_at_ms: None }
    }

    pub fn transition(&mut self, next: SessionState) -> anyhow::Result<()> {
        let valid = matches!((self.state, next),
            (SessionState::Starting, SessionState::Listening) |
            (SessionState::Listening, SessionState::Finalizing) |
            (SessionState::Finalizing, SessionState::Cleaning) |
            (SessionState::Cleaning, SessionState::Completed) |
            (SessionState::Completed, SessionState::Synthesizing) |
            (SessionState::Synthesizing, SessionState::Completed)
        ) || next == SessionState::Failed;
        anyhow::ensure!(valid, "invalid session transition: {:?} -> {:?}", self.state, next);
        self.state = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_transition() {
        let mut s = Session::new(SessionMode::Thinking, 0);
        assert!(s.transition(SessionState::Completed).is_err());
    }
}
