//! Which Windows user is on the other end of a loopback TCP connection.
//!
//! Every local user can reach `127.0.0.1`, so on a shared machine another
//! user could publish into this user's Desktop by sending an allowed `Origin`
//! (it's just a header, to anything that isn't a browser). Windows lists every
//! TCP connection with its owning process (`GetExtendedTcpTable`); the
//! client's end of an accepted connection is the row whose local address is
//! the connection's peer address, and that process's token says which user it
//! is (`user.rs`). Connections from another user are closed before anything is
//! read.

use std::net::{SocketAddr, SocketAddrV4};

use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    TCP_TABLE_OWNER_PID_CONNECTIONS,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;

use super::user::is_this_user;
use crate::platform::Owner;

pub fn loopback_owner(peer: SocketAddr, local: SocketAddr) -> Owner {
    match client_process(peer, local) {
        Some(pid) if is_this_user(pid) => Owner::ThisUser,
        // Another user's, or one this user can't even inspect. The client's
        // row is always listed while the connection is open, so not finding it
        // means something is off, and fails closed too.
        _ => Owner::OtherUser,
    }
}

/// The process whose socket is `peer`, connected to `local`: the client's
/// side of the connection Desktop accepted.
fn client_process(peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    let (SocketAddr::V4(peer), SocketAddr::V4(local)) = (peer, local) else {
        return None;
    };
    // Addresses are stored as the bytes they travel in, ports as a network-order word.
    let key = |address: &SocketAddrV4| (u32::from_ne_bytes(address.ip().octets()), address.port());
    let (client, server) = (key(&peer), key(&local));
    rows(|row| {
        let row_key = |address: u32, port: u32| (address, u16::from_be(port as u16));
        (row_key(row.dwLocalAddr, row.dwLocalPort) == client
            && row_key(row.dwRemoteAddr, row.dwRemotePort) == server)
            .then_some(row.dwOwningPid)
    })
}

/// What `pick` takes from the first row it likes, from a table read as a
/// whole: Windows has no call for one connection. Connections come and go
/// while it's read, so a table that outgrew its buffer is read again.
fn rows(pick: impl Fn(&MIB_TCPROW_OWNER_PID) -> Option<u32>) -> Option<u32> {
    let mut buffer = vec![0u64; 512];
    for _ in 0..8 {
        let mut size = (buffer.len() * 8) as u32;
        // SAFETY: the buffer is `size` bytes, 8-aligned.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                0,
                u32::from(AF_INET),
                TCP_TABLE_OWNER_PID_CONNECTIONS,
                0,
            )
        };
        match status {
            NO_ERROR => {
                // SAFETY: on success the buffer holds a MIB_TCPTABLE_OWNER_PID
                // of `dwNumEntries` rows, read within its bounds.
                let rows = unsafe {
                    let table = &*buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
                    std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize)
                };
                return rows.iter().find_map(pick);
            }
            ERROR_INSUFFICIENT_BUFFER => buffer.resize((size as usize).div_ceil(8) + 64, 0),
            _ => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn a_real_loopback_connection_is_recognized_as_this_user() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (accepted, peer) = listener.accept().unwrap();
        let local = accepted.local_addr().unwrap();
        assert_eq!(client_process(peer, local), Some(std::process::id()));
        assert_eq!(loopback_owner(peer, local), Owner::ThisUser);
        drop(client);
    }

    #[test]
    fn a_connection_that_isnt_listed_fails_closed() {
        let local: SocketAddr = "127.0.0.1:57179".parse().unwrap();
        let unknown: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert_eq!(client_process(unknown, local), None);
        assert_eq!(loopback_owner(unknown, local), Owner::OtherUser);
        // Desktop only listens on IPv4 loopback.
        let v6: SocketAddr = "[::1]:50000".parse().unwrap();
        assert_eq!(loopback_owner(v6, v6), Owner::OtherUser);
    }

    #[test]
    fn the_owner_of_many_connections_is_found_among_them() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let clients: Vec<TcpStream> = (0..40)
            .map(|_| TcpStream::connect(address).unwrap())
            .collect();
        for _ in &clients {
            let (accepted, peer) = listener.accept().unwrap();
            assert_eq!(
                loopback_owner(peer, accepted.local_addr().unwrap()),
                Owner::ThisUser
            );
        }
    }
}
