//! Checks, against the real Windows network stack, that Desktop's plain
//! `TcpListener::bind` is enough to keep its port from being taken over. On
//! Windows another program's `SO_REUSEADDR` can share a port that's in use
//! (and the newest socket then gets the connections), so this is worth
//! measuring rather than assuming: the standard library's listener refuses a
//! program that asks to share its exact address, and a wildcard bind (the
//! only other way onto the port) is less specific, so connections to
//! `127.0.0.1` still reach Desktop. Port 57179 itself is only ever bound by
//! `Server::bind`; these use free ports.

use std::io::{self, Read, Write};
use std::mem::zeroed;
use std::net::{Ipv4Addr, TcpListener, TcpStream};

use windows_sys::Win32::Networking::WinSock::{
    AF_INET, IPPROTO_TCP, SO_REUSEADDR, SOCK_STREAM, SOCKADDR, SOCKADDR_IN, SOL_SOCKET,
    WSAGetLastError, WSASocketW, bind, closesocket, listen, setsockopt,
};

/// Binds a TCP socket to `ip:port` after setting `SO_REUSEADDR`, as a program
/// trying to share or take over a port would, and listens on it.
fn bind_sharing(ip: Ipv4Addr, port: u16) -> io::Result<usize> {
    // Make sure Winsock is up: std does it on first use.
    drop(TcpListener::bind("127.0.0.1:0")?);
    // SAFETY: plain Winsock calls on a socket made here, closed on failure.
    unsafe {
        let socket = WSASocketW(
            i32::from(AF_INET),
            SOCK_STREAM,
            IPPROTO_TCP,
            std::ptr::null(),
            0,
            0,
        );
        let on: i32 = 1;
        setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, (&raw const on).cast(), 4);
        let mut name: SOCKADDR_IN = zeroed();
        name.sin_family = AF_INET;
        name.sin_port = port.to_be();
        name.sin_addr.S_un.S_addr = u32::from_ne_bytes(ip.octets());
        let bound = bind(
            socket,
            (&raw const name).cast::<SOCKADDR>(),
            size_of::<SOCKADDR_IN>() as i32,
        ) == 0
            && listen(socket, 8) == 0;
        if bound {
            Ok(socket)
        } else {
            let err = io::Error::from_raw_os_error(WSAGetLastError());
            closesocket(socket);
            Err(err)
        }
    }
}

#[test]
fn a_program_asking_to_share_the_exact_address_is_refused() {
    let desktop = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = desktop.local_addr().unwrap().port();
    let refused = bind_sharing(Ipv4Addr::LOCALHOST, port).err();
    assert_eq!(
        refused.map(|err| err.kind()),
        Some(io::ErrorKind::PermissionDenied)
    );
}

#[test]
fn a_wildcard_listener_on_the_port_doesnt_get_loopback_connections() {
    let desktop = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = desktop.local_addr().unwrap().port();
    // Whether Windows lets it bind at all, loopback traffic goes to the more specific socket.
    let squatter = bind_sharing(Ipv4Addr::UNSPECIFIED, port);
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client.write_all(b"x").unwrap();
    let (mut accepted, _) = desktop.accept().unwrap();
    let mut byte = [0u8; 1];
    accepted.read_exact(&mut byte).unwrap();
    assert_eq!(&byte, b"x");
    if let Ok(socket) = squatter {
        // SAFETY: the socket made above, closed once.
        unsafe { closesocket(socket) };
    }
}
