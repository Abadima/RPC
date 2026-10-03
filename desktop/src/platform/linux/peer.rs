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
//! Other platforms report "unknown" for now (see `platform/mod.rs`).

use std::io::BufRead;
use std::net::SocketAddr;

use crate::platform::Owner;
use crate::platform::unix::user;

pub fn loopback_owner(peer: SocketAddr, local: SocketAddr) -> Owner {
    let Ok(table) = std::fs::File::open("/proc/net/tcp") else {
        return Owner::Unknown;
    };
    match owner_uid(std::io::BufReader::new(table), peer, local) {
        Some(uid) if uid == user::current_uid() => Owner::ThisUser,
        Some(_) => Owner::OtherUser,
        // The client's socket is always listed while the connection is
        // open; not finding it means something is off, so fail closed.
        None => Owner::OtherUser,
    }
}

/// Whose program listens on `127.0.0.1:port` (or every address's `port`),
/// when Desktop can't: another user's means the browsers' Parousia is talking
/// to that program, and only the person at the machine can deal with it.
pub fn listener_owner(port: u16) -> Owner {
    let any = SocketAddr::from(([0, 0, 0, 0], 0));
    let found = [[127, 0, 0, 1], [0, 0, 0, 0]].into_iter().find_map(|ip| {
        let table = std::fs::File::open("/proc/net/tcp").ok()?;
        owner_uid(
            std::io::BufReader::new(table),
            SocketAddr::from((ip, port)),
            any,
        )
    });
    match found {
        Some(uid) if uid == user::current_uid() => Owner::ThisUser,
        Some(_) => Owner::OtherUser,
        None => Owner::Unknown,
    }
}

/// Kernel format: `%08X:%04X`, the IPv4 address as a native-endian word.
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
///
/// Read line by line and stopped at the match: the table has a row per TCP
/// socket on the machine, which can run to megabytes, and this runs for every
/// accepted connection. A read error ends the search like a missing row does.
fn owner_uid(mut table: impl BufRead, peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    let (client, server) = (proc_address(peer)?, proc_address(local)?);
    // One buffer for every row, the header first.
    let mut line = String::new();
    table.read_line(&mut line).ok()?;
    loop {
        line.clear();
        if table.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let mut fields = line.split_whitespace().skip(1);
        if fields.next() == Some(&client) && fields.next() == Some(&server) {
            // `st`, `tx_queue:rx_queue`, `tr:tm->when`, and `retrnsmt` come first.
            return fields.nth(4)?.parse().ok();
        }
    }
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
        assert_eq!(owner_uid(TABLE.as_bytes(), client, server), Some(1001));
        let unknown: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert_eq!(owner_uid(TABLE.as_bytes(), unknown, server), None);
    }

    #[test]
    fn addresses_use_the_kernel_format() {
        let address: SocketAddr = "127.0.0.1:57179".parse().unwrap();
        assert_eq!(proc_address(address).as_deref(), Some("0100007F:DF5B"));
    }

    #[test]
    fn a_listener_is_known_by_its_owner() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(listener_owner(port), Owner::ThisUser);
        drop(listener);
        assert_eq!(listener_owner(port), Owner::Unknown);
        // Another account's, where this machine has one listening on loopback.
        let table = std::fs::read_to_string("/proc/net/tcp").unwrap();
        let foreign = table.lines().skip(1).find_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (local, state, uid) = (fields[1], fields[3], fields[7].parse::<u32>().ok()?);
            (local.starts_with("0100007F:") && state == "0A" && uid != user::current_uid())
                .then(|| u16::from_str_radix(&local[9..], 16).ok())
                .flatten()
        });
        if let Some(port) = foreign {
            assert_eq!(listener_owner(port), Owner::OtherUser, "port {port}");
        }
    }

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
