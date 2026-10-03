//! What every build shares: the Hub that decides what each platform shows,
//! settings and where they live, control requests, the terminal console, and
//! the Presence model.

pub mod config;
pub mod console;
pub mod control;
pub mod hub;
pub mod presence;
