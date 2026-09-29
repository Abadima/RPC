//! Which OS user is on the other end of a loopback TCP connection.
//!
//! Every local user can reach `127.0.0.1`, unlike Desktop's socket in a
//! private directory, so on a shared machine another user could otherwise
//! publish into this user's Desktop by sending an allowed `Origin` (it's just
//! a header, to anything that isn't a browser). Linux lists each TCP socket
//! with its owner in `/proc/net/tcp`; the client's end of an accepted
//! connection is the entry whose local address is the connection's peer
//! address. Connections from another user are closed before anything is read.
//!
//! Other platforms have equivalents that aren't implemented yet (Windows'
//! `GetExtendedTcpTable` gives the owning process; macOS needs `libproc`), so
//! there the check reports "unknown" and the connection is treated as
//! unverified: it may publish presence but not change settings.

use std::net::SocketAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    not(target_os = "linux"),
    allow(
        dead_code,
        reason = "only Linux can tell who owns a loopback connection so far"
    )
)]
pub enum Owner {
    ThisUser,
    OtherUser,
    Unknown,
}

pub fn loopback_owner(peer: SocketAddr, local: SocketAddr) -> Owner {
    #[cfg(target_os = "linux")]
    {
        let (Some(me), Ok(table)) = (current_uid(), std::fs::read_to_string("/proc/net/tcp"))
        else {
            return Owner::Unknown;
        };
        match owner_uid(&table, peer, local) {
            Some(uid) if uid == me => Owner::ThisUser,
            Some(_) => Owner::OtherUser,
            // The client's socket is always listed while the connection is
            // open; not finding it means something is off, so fail closed.
            None => Owner::OtherUser,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (peer, local);
        Owner::Unknown
    }
}

#[cfg(target_os = "linux")]
fn current_uid() -> Option<u32> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// Kernel format: `%08X:%04X`, the IPv4 address as a native-endian word.
#[cfg(any(target_os = "linux", test))]
fn proc_address(address: SocketAddr) -> Option<String> {
    match address {
        SocketAddr::V4(v4) => Some(format!(
            "{:08X}:{:04X}",
            u32::from_ne_bytes(v4.ip().octets()),
            v4.port()
        )),
        SocketAddr::V6(_) => None,
    }
}

/// The owner of the socket whose local end is `peer` and remote end is
/// `local`: the client's side of the connection Desktop accepted.
#[cfg(any(target_os = "linux", test))]
fn owner_uid(table: &str, peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    let (client, server) = (proc_address(peer)?, proc_address(local)?);
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        (fields.get(1) == Some(&client.as_str()) && fields.get(2) == Some(&server.as_str()))
            .then(|| fields.get(7)?.parse().ok())
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:DF5B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:DF5B 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:A1B2 0100007F:DF5B 01 00000000:00000000 00:00000000 00000000  1001        0 33333 1 0000000000000000 20 4 30 10 -1
";

    #[test]
    fn finds_the_owner_of_the_clients_end() {
        let server: SocketAddr = "127.0.0.1:57179".parse().unwrap();
        let client: SocketAddr = "127.0.0.1:41394".parse().unwrap();
        // Row 1 is Desktop's own end (uid 1000); row 2 is the client's (1001).
        assert_eq!(owner_uid(TABLE, client, server), Some(1001));
        let unknown: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert_eq!(owner_uid(TABLE, unknown, server), None);
    }

    #[test]
    fn addresses_use_the_kernel_format() {
        let address: SocketAddr = "127.0.0.1:57179".parse().unwrap();
        assert_eq!(proc_address(address).as_deref(), Some("0100007F:DF5B"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_loopback_connection_is_recognized_as_this_user() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (accepted, peer) = listener.accept().unwrap();
        assert_eq!(
            loopback_owner(peer, accepted.local_addr().unwrap()),
            Owner::ThisUser
        );
        drop(client);
    }
}
