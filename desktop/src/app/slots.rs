//! A thread per connection, at most `max` at once. A connection without a free
//! slot, or whose thread won't start, is dropped; a slot comes back however its
//! thread ends, a panic included.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

pub struct Slots {
    open: Arc<AtomicUsize>,
    max: usize,
}

struct Taken(Arc<AtomicUsize>);

impl Drop for Taken {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Slots {
    pub fn new(max: usize) -> Self {
        Self {
            open: Arc::new(AtomicUsize::new(0)),
            max,
        }
    }

    pub fn spawn(&self, serve: impl FnOnce() + Send + 'static) {
        if self.open.fetch_add(1, Ordering::SeqCst) >= self.max {
            self.open.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let taken = Taken(Arc::clone(&self.open));
        // On an error the closure, and `taken` with it, is dropped here.
        let _ = thread::Builder::new().spawn(move || {
            let _taken = taken;
            serve();
        });
    }

    #[cfg(test)]
    pub fn open(&self) -> usize {
        self.open.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn settled(slots: &Slots, want: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while slots.open() != want {
            assert!(
                Instant::now() < deadline,
                "{} open, wanted {want}",
                slots.open()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn at_most_max_run_and_a_finished_one_frees_its_slot() {
        let slots = Slots::new(2);
        let (release, held) = mpsc::channel::<()>();
        let held = Arc::new(std::sync::Mutex::new(held));
        let (ran, started) = mpsc::channel();
        for i in 0..5 {
            let (held, ran) = (Arc::clone(&held), ran.clone());
            slots.spawn(move || {
                ran.send(i).unwrap();
                let _ = held.lock().unwrap().recv();
            });
        }
        settled(&slots, 2);
        for _ in 0..2 {
            started.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        assert!(
            started.recv_timeout(Duration::from_millis(100)).is_err(),
            "the rest were dropped"
        );
        release.send(()).unwrap();
        release.send(()).unwrap();
        settled(&slots, 0);
        slots.spawn(|| {});
        settled(&slots, 0);
    }

    #[test]
    fn a_thread_that_panics_gives_its_slot_back() {
        let slots = Slots::new(1);
        for _ in 0..3 {
            slots.spawn(|| panic!("a handler that fails"));
            settled(&slots, 0);
        }
        let (ran, done) = mpsc::channel();
        slots.spawn(move || ran.send(()).unwrap());
        done.recv_timeout(Duration::from_secs(5))
            .expect("still served after the panics");
    }
}
