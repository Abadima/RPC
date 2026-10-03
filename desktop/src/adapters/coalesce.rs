//! Spaces out rapid changes within one Activity, for every adapter.
//!
//! The Hub wraps each adapter in this one. A change of subject (another
//! Activity, another Discord Application, or nothing) goes through at once and
//! throws away anything still waiting, so a platform never shows an Activity
//! the Hub has moved on from. A change within the Activity that's showing (the
//! next video, a new track, a seek) goes through at once too, unless the
//! adapter was told something less than `INTERVAL` ago. Then the newest such
//! change waits for the interval to end, and a newer one replaces it without
//! moving that time. So the first change after a calm spell is never delayed,
//! a burst shows its first and its last, and however steadily changes keep
//! coming, what's shown is at most one interval behind.
//!
//! Nothing runs between changes: one short-lived thread exists only while an
//! update is waiting. This is not a model of any platform's rate limit; an
//! adapter still keeps to its platform's own (see `discord`).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::adapters::{AdapterStatus, Platform, PlatformAdapter};
use crate::app::presence::Activity;

/// The least time between two updates within one Activity.
const INTERVAL: Duration = Duration::from_secs(2);

/// What the adapter was last told to show, and when.
struct Shown {
    /// What makes a new Activity an update of this one, not a new subject.
    id: String,
    client_id: Option<String>,
    at: Instant,
}

impl Shown {
    fn of(activity: &Activity, at: Instant) -> Self {
        Self {
            id: activity.id.clone(),
            client_id: activity.discord_client_id.clone(),
            at,
        }
    }

    fn is_update(&self, activity: &Activity) -> bool {
        self.id == activity.id && self.client_id == activity.discord_client_id
    }
}

#[derive(Default)]
struct State {
    shown: Option<Shown>,
    /// The newest update within `shown`, for when the interval ends.
    waiting: Option<Activity>,
    /// Whether the timer thread is running.
    timer: bool,
}

struct Shared {
    inner: Box<dyn PlatformAdapter>,
    interval: Duration,
    /// Held while the adapter is told something, so the timer and `show`
    /// can't reach it out of order. The adapter returns at once.
    state: Mutex<State>,
}

pub struct Coalesced {
    shared: Arc<Shared>,
}

impl Coalesced {
    pub fn new(inner: Box<dyn PlatformAdapter>) -> Self {
        Self::with(inner, INTERVAL)
    }

    fn with(inner: Box<dyn PlatformAdapter>, interval: Duration) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner,
                interval,
                state: Mutex::new(State::default()),
            }),
        }
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    /// Tells the adapter now, and drops anything waiting: it's older.
    fn send(&self, state: &mut State, activity: Option<Activity>, now: Instant) {
        state.waiting = None;
        match (&mut state.shown, &activity) {
            // The same subject: only the time moves.
            (Some(shown), Some(next)) if shown.is_update(next) => shown.at = now,
            _ => state.shown = activity.as_ref().map(|next| Shown::of(next, now)),
        }
        self.inner.show(activity);
    }
}

impl PlatformAdapter for Coalesced {
    fn platform(&self) -> Platform {
        self.shared.inner.platform()
    }

    fn show(&self, activity: Option<Activity>) {
        let shared = &self.shared;
        let mut state = lock(&shared.state);
        let now = Instant::now();
        let early = activity.as_ref().is_some_and(|next| {
            state
                .shown
                .as_ref()
                .is_some_and(|shown| shown.is_update(next) && now < shown.at + shared.interval)
        });
        if !early {
            shared.send(&mut state, activity, now);
            return;
        }
        state.waiting = activity;
        if state.timer {
            return;
        }
        state.timer = true;
        let timer = Arc::clone(shared);
        let started = thread::Builder::new()
            .name("coalesce".into())
            .spawn(move || run_timer(&timer));
        if started.is_err() {
            // Better an early update than one that never arrives.
            state.timer = false;
            let activity = state.waiting.take();
            shared.send(&mut state, activity, now);
        }
    }

    fn status(&self) -> AdapterStatus {
        self.shared.inner.status()
    }
}

/// Sleeps until the interval since the adapter was last told something ends,
/// then shows the newest update still waiting. A change of subject sends
/// that time forward and clears the wait, so this ends having shown nothing
/// stale, at most one interval later.
fn run_timer(shared: &Shared) {
    loop {
        let mut state = lock(&shared.state);
        let now = Instant::now();
        let left = match (&state.waiting, &state.shown) {
            (Some(_), Some(shown)) => (shown.at + shared.interval).saturating_duration_since(now),
            _ => Duration::ZERO,
        };
        if left.is_zero() {
            state.timer = false;
            if let Some(activity) = state.waiting.take() {
                shared.send(&mut state, Some(activity), now);
            }
            return;
        }
        drop(state);
        thread::sleep(left);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::AdapterState;
    use crate::app::hub::tests::example_activity;

    const STEP: Duration = Duration::from_millis(150);

    /// What the adapter was told, in order: the Activity's id and details.
    type Told = Option<(String, Option<String>)>;
    type Log = Arc<Mutex<Vec<(Instant, Told)>>>;

    struct Recorder(Log);

    impl PlatformAdapter for Recorder {
        fn platform(&self) -> Platform {
            Platform::Discord
        }

        fn show(&self, activity: Option<Activity>) {
            self.0
                .lock()
                .unwrap()
                .push((Instant::now(), activity.map(|a| (a.id, a.details))));
        }

        fn status(&self) -> AdapterStatus {
            AdapterStatus {
                platform: Platform::Discord,
                state: AdapterState::Idle,
                activity: None,
                error: None,
            }
        }
    }

    fn setup() -> (Coalesced, Log) {
        let log = Log::default();
        let coalesced = Coalesced::with(Box::new(Recorder(Arc::clone(&log))), STEP);
        (coalesced, log)
    }

    fn activity(id: &str, details: &str) -> Activity {
        let mut activity = example_activity(id);
        activity.details = Some(details.into());
        activity
    }

    fn told(id: &str, details: &str) -> Told {
        Some((id.into(), Some(details.into())))
    }

    fn calls(log: &Log) -> Vec<Told> {
        log.lock()
            .unwrap()
            .iter()
            .map(|(_, told)| told.clone())
            .collect()
    }

    fn wait_for(log: &Log, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while calls(log).len() < count {
            assert!(Instant::now() < deadline, "still {:?}", calls(log));
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Long enough for anything that was going to arrive to have done so.
    fn settle() {
        thread::sleep(STEP * 3);
    }

    #[test]
    fn a_new_subject_is_shown_at_once() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "video")));
        coalesced.show(Some(activity("github", "repo")));
        assert_eq!(
            calls(&log),
            [told("youtube", "video"), told("github", "repo")]
        );
    }

    #[test]
    fn a_change_of_application_is_a_new_subject() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "video")));
        let mut other = activity("youtube", "video");
        other.discord_client_id = Some("1553980756731363428".into());
        coalesced.show(Some(other));
        assert_eq!(calls(&log).len(), 2);
    }

    #[test]
    fn the_first_update_after_a_calm_spell_is_not_delayed() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "a")));
        thread::sleep(STEP + STEP / 2);
        coalesced.show(Some(activity("youtube", "b")));
        assert_eq!(calls(&log), [told("youtube", "a"), told("youtube", "b")]);
        assert!(!lock(&coalesced.shared.state).timer, "nothing was started");
    }

    #[test]
    fn a_burst_shows_its_first_and_its_last_one_interval_after_the_first() {
        let (coalesced, log) = setup();
        let first = Instant::now();
        coalesced.show(Some(activity("youtube", "a")));
        coalesced.show(Some(activity("youtube", "b")));
        coalesced.show(Some(activity("youtube", "c")));
        coalesced.show(Some(activity("youtube", "d")));
        assert_eq!(calls(&log), [told("youtube", "a")], "the rest waits");
        wait_for(&log, 2);
        let late = log.lock().unwrap()[1].0.duration_since(first);
        assert!(late >= STEP, "not before the interval ends: {late:?}");
        assert!(late < STEP * 2, "and not much after it: {late:?}");
        settle();
        assert_eq!(calls(&log), [told("youtube", "a"), told("youtube", "d")]);
        // Shown, so the timer has ended and the next update starts afresh.
        assert!(!lock(&coalesced.shared.state).timer);
    }

    #[test]
    fn steady_changes_never_starve() {
        let (coalesced, log) = setup();
        let started = Instant::now();
        let mut step = 0;
        while started.elapsed() < STEP * 6 {
            coalesced.show(Some(activity("youtube", &step.to_string())));
            step += 1;
            thread::sleep(STEP / 10);
        }
        let seen = log.lock().unwrap().clone();
        assert!(seen.len() >= 4, "kept up while changes went on: {seen:?}");
        for pair in seen.windows(2) {
            let gap = pair[1].0.duration_since(pair[0].0);
            assert!(gap >= STEP - Duration::from_millis(20), "spaced: {gap:?}");
        }
        settle();
        let last = format!("{}", step - 1);
        assert_eq!(calls(&log).last(), Some(&told("youtube", &last)));
    }

    #[test]
    fn a_new_subject_discards_what_was_waiting() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "a")));
        coalesced.show(Some(activity("youtube", "b")));
        coalesced.show(Some(activity("github", "repo")));
        settle();
        assert_eq!(
            calls(&log),
            [told("youtube", "a"), told("github", "repo")],
            "the old video never shows over GitHub"
        );
    }

    #[test]
    fn clearing_is_shown_at_once_and_discards_what_was_waiting() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "a")));
        coalesced.show(Some(activity("youtube", "b")));
        coalesced.show(None);
        settle();
        assert_eq!(calls(&log), [told("youtube", "a"), None]);
        // Something after nothing is a new subject too.
        coalesced.show(Some(activity("youtube", "c")));
        assert_eq!(calls(&log).len(), 3);
    }

    #[test]
    fn rapid_changes_of_subject_leave_nothing_stale() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "a")));
        coalesced.show(Some(activity("youtube", "b")));
        coalesced.show(Some(activity("github", "x")));
        coalesced.show(Some(activity("github", "y")));
        coalesced.show(Some(activity("youtube", "c")));
        coalesced.show(Some(activity("netflix", "z")));
        settle();
        assert_eq!(
            calls(&log),
            [
                told("youtube", "a"),
                told("github", "x"),
                told("youtube", "c"),
                told("netflix", "z"),
            ]
        );
    }

    #[test]
    fn a_waiting_update_is_spaced_from_a_change_of_subject_too() {
        let (coalesced, log) = setup();
        coalesced.show(Some(activity("youtube", "a")));
        coalesced.show(Some(activity("github", "x")));
        let switched = Instant::now();
        coalesced.show(Some(activity("github", "y")));
        assert_eq!(calls(&log).len(), 2, "y waits out the interval from x");
        wait_for(&log, 3);
        assert!(switched.elapsed() >= STEP - Duration::from_millis(20));
        assert_eq!(calls(&log).last(), Some(&told("github", "y")));
    }
}
