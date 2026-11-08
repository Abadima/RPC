//! Which OS user is on the other end of a loopback TCP connection. Any local user
//! can reach `127.0.0.1` and send an allowed `Origin` (outside a browser it's just
//! a header), so a connection from another user is closed before anything is
//! read. The kernel's socket diagnostics (netlink) look up the client's socket;
//! `/proc/net/tcp` is the fallback.

use std::io::BufRead;
use std::net::{SocketAddr, SocketAddrV4};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

use crate::platform::Owner;
use crate::platform::unix::user;

pub fn loopback_owner(peer: SocketAddr, local: SocketAddr) -> Owner {
    if let Some(uid) = diag_owner_uid(peer, local) {
        return owner(uid);
    }
    let Ok(table) = std::fs::File::open("/proc/net/tcp") else {
        return Owner::Unknown;
    };
    match owner_uid(std::io::BufReader::new(table), peer, local) {
        Some(uid) => owner(uid),
        // The client's socket is always listed while the connection is
        // open; not finding it means something is off, so fail closed.
        None => Owner::OtherUser,
    }
}

fn owner(uid: u32) -> Owner {
    if uid == user::current_uid() {
        Owner::ThisUser
    } else {
        Owner::OtherUser
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
    found.map_or(Owner::Unknown, owner)
}

unsafe extern "C" {
    fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
    fn send(fd: i32, buf: *const u8, len: usize, flags: i32) -> isize;
    fn recv(fd: i32, buf: *mut u8, len: usize, flags: i32) -> isize;
}

const AF_INET: u8 = 2;
const IPPROTO_TCP: u8 = 6;
const SOCK_DIAG_BY_FAMILY: u16 = 20;
const NLM_F_REQUEST: u16 = 1;
const DIAG_SEQ: u32 = 1;
/// `nlmsghdr` (16 bytes), then `inet_diag_req_v2` (56).
const DIAG_REQUEST_LEN: usize = 72;
/// Where the socket's addresses start: in the request, after the header
/// and family, protocol, extensions, padding, and states; in the reply
/// (`inet_diag_msg`), after the header and family, state, timer, retransmits.
const REQUEST_ID: usize = 24;
const REPLY_ID: usize = 20;
/// Both ports and both addresses: what identifies the socket.
const ID_ADDRESSES: usize = 36;
/// After the reply's addresses, interface, cookie, expiry and both queues.
const REPLY_UID: usize = 80;

/// The owner of the socket whose local end is `peer` and remote end `local`, looked
/// up by its addresses: about 2 µs, where `/proc/net/tcp` costs 0.2 to 0.3 ms.
/// `None` where netlink can't answer, and the table decides.
fn diag_owner_uid(peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    const AF_NETLINK: i32 = 16;
    /// `SOCK_DGRAM | SOCK_CLOEXEC` as most architectures number them; where
    /// they differ, `socket` refuses this.
    const DGRAM_CLOEXEC: i32 = 2 | 0o2_000_000;
    const NETLINK_SOCK_DIAG: i32 = 4;
    /// The kernel has answered by the time `send` returns: never wait.
    const MSG_DONTWAIT: i32 = 0x40;

    let (SocketAddr::V4(peer), SocketAddr::V4(local)) = (peer, local) else {
        return None;
    };
    let request = diag_request(peer, local);
    // SAFETY: plain system calls on a descriptor that `OwnedFd` owns (and
    // closes) from here on; each buffer outlives the call given it, with
    // its true length.
    unsafe {
        let fd = socket(AF_NETLINK, DGRAM_CLOEXEC, NETLINK_SOCK_DIAG);
        if fd < 0 {
            return None;
        }
        let fd = OwnedFd::from_raw_fd(fd);
        let sent = send(fd.as_raw_fd(), request.as_ptr(), request.len(), 0);
        if usize::try_from(sent).ok()? != request.len() {
            return None;
        }
        // The 88 bytes read, and room for the attributes after them; a
        // longer reply is cut short, which loses nothing read here.
        let mut reply = [0u8; 256];
        let received = recv(
            fd.as_raw_fd(),
            reply.as_mut_ptr(),
            reply.len(),
            MSG_DONTWAIT,
        );
        diag_reply_uid(reply.get(..usize::try_from(received).ok()?)?, &request)
    }
}

/// A lookup of one TCP socket: host byte order, except for the ports and
/// addresses, which are the network's.
fn diag_request(peer: SocketAddrV4, local: SocketAddrV4) -> [u8; DIAG_REQUEST_LEN] {
    let mut request = [0u8; DIAG_REQUEST_LEN];
    request[0..4].copy_from_slice(&(DIAG_REQUEST_LEN as u32).to_ne_bytes());
    request[4..6].copy_from_slice(&SOCK_DIAG_BY_FAMILY.to_ne_bytes());
    request[6..8].copy_from_slice(&NLM_F_REQUEST.to_ne_bytes());
    request[8..12].copy_from_slice(&DIAG_SEQ.to_ne_bytes());
    request[16] = AF_INET;
    request[17] = IPPROTO_TCP;
    // Every state: a lookup by address isn't filtered by state anyway.
    request[20..24].copy_from_slice(&u32::MAX.to_ne_bytes());
    let id = &mut request[REQUEST_ID..];
    id[0..2].copy_from_slice(&peer.port().to_be_bytes());
    id[2..4].copy_from_slice(&local.port().to_be_bytes());
    id[4..8].copy_from_slice(&peer.ip().octets());
    id[20..24].copy_from_slice(&local.ip().octets());
    // `INET_DIAG_NOCOOKIE`: found by its addresses alone.
    id[40..48].fill(0xff);
    request
}

/// The uid in a reply to `request`, if it's an answer (not an error) about
/// the very socket asked for.
fn diag_reply_uid(reply: &[u8], request: &[u8]) -> Option<u32> {
    let kind = u16::from_ne_bytes(reply.get(4..6)?.try_into().ok()?);
    let about_it = kind == SOCK_DIAG_BY_FAMILY
        && reply.get(8..12) == request.get(8..12)
        && reply.get(16) == Some(&AF_INET)
        && reply.get(REPLY_ID..REPLY_ID + ID_ADDRESSES)
            == request.get(REQUEST_ID..REQUEST_ID + ID_ADDRESSES);
    if !about_it {
        return None;
    }
    Some(u32::from_ne_bytes(
        reply.get(REPLY_UID..REPLY_UID + 4)?.try_into().ok()?,
    ))
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
    fn netlink_finds_the_clients_end_and_nothing_else() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (accepted, peer) = listener.accept().unwrap();
        let local = accepted.local_addr().unwrap();
        assert_eq!(diag_owner_uid(peer, local), Some(user::current_uid()));
        let table = std::fs::read_to_string("/proc/net/tcp").unwrap();
        assert_eq!(
            diag_owner_uid(peer, local),
            owner_uid(table.as_bytes(), peer, local)
        );
        let nobody: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert_eq!(diag_owner_uid(nobody, local), None);
        drop(client);
    }

    #[test]
    fn only_a_reply_about_the_socket_asked_for_counts() {
        let peer: SocketAddrV4 = "127.0.0.1:41394".parse().unwrap();
        let local: SocketAddrV4 = "127.0.0.1:57179".parse().unwrap();
        let request = diag_request(peer, local);
        let mut reply = [0u8; 88];
        reply[..16].copy_from_slice(&request[..16]);
        reply[16] = AF_INET;
        reply[REPLY_ID..REPLY_ID + ID_ADDRESSES]
            .copy_from_slice(&request[REQUEST_ID..REQUEST_ID + ID_ADDRESSES]);
        reply[REPLY_UID..REPLY_UID + 4].copy_from_slice(&1001u32.to_ne_bytes());
        assert_eq!(diag_reply_uid(&reply, &request), Some(1001));

        let mut other_port = reply;
        other_port[REPLY_ID + 1] ^= 1;
        assert_eq!(diag_reply_uid(&other_port, &request), None);
        let mut error = reply;
        // `NLMSG_ERROR`.
        error[4..6].copy_from_slice(&2u16.to_ne_bytes());
        assert_eq!(diag_reply_uid(&error, &request), None);
        assert_eq!(diag_reply_uid(&reply[..REPLY_UID], &request), None);
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
