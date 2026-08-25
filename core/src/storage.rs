use rusqlite::{params, Connection};
use crate::{session::Session, transcript::TranscriptSegment};

pub struct Store { conn: Connection }

impl Store {
    pub fn open(path: impl AsRef<std::path::Path>) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> anyhow::Result<()> {
        self.conn.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, mode TEXT NOT NULL, state TEXT NOT NULL, title TEXT, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER);
        CREATE TABLE IF NOT EXISTS transcript_segments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, speaker TEXT NOT NULL, raw_text TEXT NOT NULL, clean_text TEXT, confidence REAL, status TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
        CREATE INDEX IF NOT EXISTS idx_segments_session_start ON transcript_segments(session_id, start_ms);")?;
        Ok(())
    }

    pub fn save_session(&self, s: &Session) -> anyhow::Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO sessions VALUES (?1,?2,?3,?4,?5,?6)", params![s.id.to_string(), format!("{:?}",s.mode), format!("{:?}",s.state), s.title, s.started_at_ms, s.ended_at_ms])?;
        Ok(())
    }

    pub fn save_segment(&self, s: &TranscriptSegment) -> anyhow::Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO transcript_segments VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![s.id.to_string(), s.session_id.to_string(), s.start_ms, s.end_ms, format!("{:?}",s.speaker), s.raw_text, s.clean_text, s.confidence, format!("{:?}",s.status)])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Session, SessionMode};
    #[test]
    fn persists_session() {
        let store = Store::open(":memory:").unwrap();
        store.save_session(&Session::new(SessionMode::Dictation, 1)).unwrap();
    }
}
