//! The browser link: the `127.0.0.1` port, its HTTP and WebSocket handling,
//! the wire protocol, and which clients may connect.

pub mod http;
pub mod identity;
pub mod protocol;
pub mod rate;
pub mod server;
pub mod session;
pub mod ws;
