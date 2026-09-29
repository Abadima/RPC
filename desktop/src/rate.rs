//! A token bucket refilled from elapsed time when it's used, so limiting
//! needs no timer: idle, it costs nothing.

use std::time::Instant;

pub struct TokenBucket {
    capacity: f64,
    per_second: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: u32, per_second: u32) -> Self {
        Self {
            capacity: f64::from(capacity),
            per_second: f64::from(per_second),
            tokens: f64::from(capacity),
            last: Instant::now(),
        }
    }

    pub fn take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.per_second).min(self.capacity);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn allows_a_burst_then_refills_over_time() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(3, 2);
        assert!((0..3).all(|_| bucket.take(start)));
        assert!(!bucket.take(start));
        assert!(bucket.take(start + Duration::from_millis(500)));
        assert!(!bucket.take(start + Duration::from_millis(500)));
        // Never refills past its capacity.
        let later = start + Duration::from_secs(60);
        assert!((0..3).all(|_| bucket.take(later)));
        assert!(!bucket.take(later));
    }
}
