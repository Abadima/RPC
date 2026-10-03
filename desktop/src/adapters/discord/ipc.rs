//! The Discord app's local RPC framing: an 8-byte header (opcode, then body
//! length, both little-endian `u32`) and a JSON body. That's the whole
//! format, so there's no crate for it. The transport it travels over (a Unix
//! socket or a named pipe called `discord-ipc-0` to `discord-ipc-9`) is the
//! operating system's: see `platform::discord`.

use std::io::{self, Read};

pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;

/// Discord's replies are a few KiB at most (`READY` carries the user); a
/// bigger frame isn't worth reading.
pub const MAX_FRAME: usize = 64 * 1024;

pub fn encode(op: u32, body: &[u8]) -> io::Result<Vec<u8>> {
    let len = u32::try_from(body.len())
        .ok()
        .filter(|&len| len as usize <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "frame too large"))?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<(u32, Vec<u8>)> {
    let mut header = [0u8; 8];
    reader.read_exact(&mut header)?;
    let [a, b, c, d, e, f, g, h] = header;
    let op = u32::from_le_bytes([a, b, c, d]);
    let len = u32::from_le_bytes([e, f, g, h]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok((op, body))
}

/// What arrives from Discord, delivered to the adapter's queue.
#[derive(Debug)]
pub enum Incoming {
    Frame(u32, Vec<u8>),
    Closed,
}

pub type Deliver = Box<dyn Fn(Incoming) + Send>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_oversized_ones_are_refused() {
        let frame = encode(OP_FRAME, br#"{"a":1}"#).unwrap();
        assert_eq!(&frame[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        let (op, body) = read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!((op, body.as_slice()), (OP_FRAME, br#"{"a":1}"#.as_slice()));

        let mut huge = OP_FRAME.to_le_bytes().to_vec();
        huge.extend_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        assert_eq!(
            read_frame(&mut huge.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(encode(OP_FRAME, &vec![b'x'; MAX_FRAME + 1]).is_err());
        // A truncated frame is an error, not a short read.
        assert!(read_frame(&mut &frame[..10]).is_err());
    }
}
