//! CFD job registry held in Tauri managed state.
//!
//! A `JobHandle` lives in `CfdState.jobs` for the duration of a study
//! run. Cancellation flips an `AtomicBool` the runner checks between
//! cycles. The thread is left to terminate on its own — we never
//! `JoinHandle::join` from the Tauri side.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::dto::{JobStatus, StudyKind};

#[derive(Debug)]
pub struct JobHandle {
    pub kind: StudyKind,
    pub config_path: String,
    pub status: Arc<Mutex<JobStatus>>,
    pub cancel: Arc<AtomicBool>,
    pub started_at: u64,
    pub finished_at: Arc<Mutex<Option<u64>>>,
}

impl JobHandle {
    pub fn new(kind: StudyKind, config_path: String, started_at: u64) -> Self {
        Self {
            kind,
            config_path,
            status: Arc::new(Mutex::new(JobStatus::Running)),
            cancel: Arc::new(AtomicBool::new(false)),
            started_at,
            finished_at: Arc::new(Mutex::new(None)),
        }
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    #[allow(dead_code)]
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn current_status(&self) -> JobStatus {
        *self.status.lock().unwrap()
    }

    #[allow(dead_code)]
    pub fn set_status(&self, s: JobStatus, finished_at: Option<u64>) {
        *self.status.lock().unwrap() = s;
        *self.finished_at.lock().unwrap() = finished_at;
    }
}

#[derive(Default, Debug)]
pub struct CfdState {
    pub jobs: Mutex<HashMap<String, JobHandle>>,
}

impl CfdState {
    /// Returns Err if any existing job of the same kind is still running.
    pub fn register(
        &self,
        job_id: String,
        handle: JobHandle,
    ) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        for (existing_id, existing) in jobs.iter() {
            if existing.kind == handle.kind
                && existing.current_status() == JobStatus::Running
            {
                return Err(format!(
                    "another {kind:?} job is already running: {existing_id}",
                    kind = handle.kind,
                ));
            }
        }
        jobs.insert(job_id, handle);
        Ok(())
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<(), String> {
        let jobs = self.jobs.lock().unwrap();
        let handle = jobs
            .get(job_id)
            .ok_or_else(|| format!("no such job: {job_id}"))?;
        handle.cancel();
        Ok(())
    }

    pub fn snapshot(&self) -> Vec<(String, StudyKind, String, u64, Option<u64>, JobStatus)> {
        let jobs = self.jobs.lock().unwrap();
        jobs.iter()
            .map(|(id, h)| {
                (
                    id.clone(),
                    h.kind,
                    h.config_path.clone(),
                    h.started_at,
                    *h.finished_at.lock().unwrap(),
                    h.current_status(),
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_cancel() {
        let state = CfdState::default();
        let job_id = "j1".to_string();
        let handle = JobHandle::new(StudyKind::SingleRpm, "x.json".into(), 100);
        let cancel_flag = handle.cancel.clone();
        state.register(job_id.clone(), handle).unwrap();

        // Cancelling sets the flag observable from the original Arc.
        state.cancel_job(&job_id).unwrap();
        assert!(cancel_flag.load(Ordering::SeqCst));

        // Snapshot reflects the registered job.
        let snap = state.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].0, job_id);
        assert_eq!(snap[0].1, StudyKind::SingleRpm);
    }

    #[test]
    fn duplicate_kind_rejected_while_running() {
        let state = CfdState::default();
        let h1 = JobHandle::new(StudyKind::SingleRpm, "x.json".into(), 100);
        state.register("j1".into(), h1).unwrap();

        let h2 = JobHandle::new(StudyKind::SingleRpm, "y.json".into(), 200);
        let err = state.register("j2".into(), h2);
        assert!(err.is_err(), "second registration should fail while first is Running");
        assert!(err.unwrap_err().contains("j1"));
    }

    #[test]
    fn duplicate_kind_allowed_when_prior_done() {
        let state = CfdState::default();
        let h1 = JobHandle::new(StudyKind::SingleRpm, "x.json".into(), 100);
        let h1_status = h1.status.clone();
        state.register("j1".into(), h1).unwrap();

        // First job transitions to Done.
        *h1_status.lock().unwrap() = JobStatus::Done;

        let h2 = JobHandle::new(StudyKind::SingleRpm, "y.json".into(), 200);
        state.register("j2".into(), h2).expect("second job allowed once first is done");
    }

    #[test]
    fn cancel_unknown_job_errors() {
        let state = CfdState::default();
        let err = state.cancel_job("nope");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("no such job"));
    }

    #[test]
    fn parallel_registration_does_not_deadlock() {
        let state = Arc::new(CfdState::default());
        let s1 = state.clone();
        let s2 = state.clone();
        let t1 = std::thread::spawn(move || {
            let h = JobHandle::new(StudyKind::SingleRpm, "a".into(), 100);
            s1.register("a".into(), h)
        });
        let t2 = std::thread::spawn(move || {
            let h = JobHandle::new(StudyKind::SingleRpm, "b".into(), 200);
            s2.register("b".into(), h)
        });
        let r1 = t1.join().unwrap();
        let r2 = t2.join().unwrap();
        // Exactly one should succeed (the other hits the running-kind gate).
        assert!(r1.is_ok() ^ r2.is_ok(), "exactly one should win: {r1:?} {r2:?}");
        assert_eq!(state.snapshot().len(), 1);
    }
}
