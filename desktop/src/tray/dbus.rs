//! Just enough of the D-Bus wire protocol for the tray: connecting to the
//! session bus, EXTERNAL authentication, and (un)marshalling messages. Written
//! against the D-Bus specification rather than pulling in a D-Bus library
//! and the async runtime it brings (see project/architecture.md, Desktop
//! Tray). Messages arrive through the bus daemon, which validates framing
//! before routing them, and only this user's processes can send to us; this
//! parser still bounds sizes and nesting and never panics on bad input.

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

/// Far above anything the tray sends or receives; a larger message means
/// something is wrong, and the connection is dropped rather than buffering it.
const MAX_MESSAGE_SIZE: usize = 1 << 20;
/// The specification's own limit: 32 levels each of arrays and structs.
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Byte(u8),
    Bool(bool),
    I16(i16),
    U16(u16),
    I32(i32),
    U32(u32),
    I64(i64),
    U64(u64),
    F64(f64),
    Str(String),
    Path(String),
    Sig(String),
    Fd(u32),
    /// `ay`, kept as bytes rather than one `Value` per byte.
    Bytes(Vec<u8>),
    /// Element signature, then the elements. The signature is what an empty
    /// array is marshalled with.
    Array(String, Vec<Value>),
    Struct(Vec<Value>),
    Entry(Box<Value>, Box<Value>),
    Variant(Box<Value>),
}

impl Value {
    pub fn signature(&self) -> String {
        match self {
            Self::Byte(_) => "y".into(),
            Self::Bool(_) => "b".into(),
            Self::I16(_) => "n".into(),
            Self::U16(_) => "q".into(),
            Self::I32(_) => "i".into(),
            Self::U32(_) => "u".into(),
            Self::I64(_) => "x".into(),
            Self::U64(_) => "t".into(),
            Self::F64(_) => "d".into(),
            Self::Str(_) => "s".into(),
            Self::Path(_) => "o".into(),
            Self::Sig(_) => "g".into(),
            Self::Fd(_) => "h".into(),
            Self::Bytes(_) => "ay".into(),
            Self::Array(element, _) => format!("a{element}"),
            Self::Struct(fields) => format!(
                "({})",
                fields.iter().map(Self::signature).collect::<String>()
            ),
            Self::Entry(key, value) => format!("{{{}{}}}", key.signature(), value.signature()),
            Self::Variant(_) => "v".into(),
        }
    }

    pub fn str(value: &str) -> Self {
        Self::Str(value.to_string())
    }

    pub fn variant(value: Self) -> Self {
        Self::Variant(Box::new(value))
    }

    /// `a{sv}` from name/value pairs.
    pub fn dict(entries: Vec<(&str, Value)>) -> Self {
        Self::Array(
            "{sv}".into(),
            entries
                .into_iter()
                .map(|(key, value)| {
                    Self::Entry(Box::new(Self::str(key)), Box::new(Self::variant(value)))
                })
                .collect(),
        )
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) | Self::Path(s) | Self::Sig(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i32(&self) -> Option<i32> {
        match self {
            Self::I32(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(_, items) => Some(items),
            _ => None,
        }
    }
}

fn alignment(signature: &str) -> usize {
    match signature.as_bytes().first() {
        Some(b'n' | b'q') => 2,
        Some(b'b' | b'i' | b'u' | b's' | b'o' | b'a' | b'h') => 4,
        Some(b'x' | b't' | b'd' | b'(' | b'{') => 8,
        _ => 1,
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Splits the first single complete type off a signature.
pub fn split_first(signature: &str) -> io::Result<(&str, &str)> {
    let end = complete_type_end(signature.as_bytes(), 0, 0)?;
    Ok(signature.split_at(end))
}

fn complete_type_end(signature: &[u8], start: usize, depth: usize) -> io::Result<usize> {
    if depth > MAX_DEPTH {
        return Err(invalid("signature nests too deeply"));
    }
    match signature.get(start) {
        Some(
            b'y' | b'b' | b'n' | b'q' | b'i' | b'u' | b'x' | b't' | b'd' | b's' | b'o' | b'g'
            | b'h' | b'v',
        ) => Ok(start + 1),
        Some(b'a') => complete_type_end(signature, start + 1, depth + 1),
        Some(b'(') => {
            let mut at = start + 1;
            if signature.get(at) == Some(&b')') {
                return Err(invalid("empty struct"));
            }
            loop {
                match signature.get(at) {
                    Some(b')') => return Ok(at + 1),
                    Some(_) => at = complete_type_end(signature, at, depth + 1)?,
                    None => return Err(invalid("unterminated struct")),
                }
            }
        }
        Some(b'{') => {
            let key_end = complete_type_end(signature, start + 1, depth + 1)?;
            if key_end != start + 2 || matches!(signature[start + 1], b'a' | b'(' | b'{' | b'v') {
                return Err(invalid("dict key must be a basic type"));
            }
            let value_end = complete_type_end(signature, key_end, depth + 1)?;
            match signature.get(value_end) {
                Some(b'}') => Ok(value_end + 1),
                _ => Err(invalid("unterminated dict entry")),
            }
        }
        _ => Err(invalid("bad signature")),
    }
}

/// Marshals little-endian. Alignment is relative to the start of `buf`,
/// which is the message start for the header and an 8-aligned body start
/// for the body, so both come out right.
#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    fn pad(&mut self, align: usize) {
        let padding = (align - self.buf.len() % align) % align;
        self.buf.resize(self.buf.len() + padding, 0);
    }

    fn u32(&mut self, value: u32) {
        self.pad(4);
        self.buf.extend(value.to_le_bytes());
    }

    fn str(&mut self, value: &str) {
        self.u32(u32::try_from(value.len()).unwrap_or(u32::MAX));
        self.buf.extend(value.as_bytes());
        self.buf.push(0);
    }

    pub fn value(&mut self, value: &Value) {
        match value {
            Value::Byte(v) => self.buf.push(*v),
            Value::Bool(v) => self.u32(u32::from(*v)),
            Value::I16(v) => {
                self.pad(2);
                self.buf.extend(v.to_le_bytes());
            }
            Value::U16(v) => {
                self.pad(2);
                self.buf.extend(v.to_le_bytes());
            }
            Value::I32(v) => {
                self.pad(4);
                self.buf.extend(v.to_le_bytes());
            }
            Value::U32(v) | Value::Fd(v) => self.u32(*v),
            Value::I64(v) => {
                self.pad(8);
                self.buf.extend(v.to_le_bytes());
            }
            Value::U64(v) => {
                self.pad(8);
                self.buf.extend(v.to_le_bytes());
            }
            Value::F64(v) => {
                self.pad(8);
                self.buf.extend(v.to_le_bytes());
            }
            Value::Str(v) | Value::Path(v) => self.str(v),
            Value::Sig(v) => {
                self.buf.push(u8::try_from(v.len()).unwrap_or(u8::MAX));
                self.buf.extend(v.as_bytes());
                self.buf.push(0);
            }
            Value::Bytes(bytes) => {
                self.u32(u32::try_from(bytes.len()).unwrap_or(u32::MAX));
                self.buf.extend(bytes);
            }
            Value::Array(element, items) => {
                self.u32(0);
                let length_at = self.buf.len() - 4;
                // Padding to the first element is present even when there are
                // no elements, and isn't counted in the length.
                self.pad(alignment(element));
                let start = self.buf.len();
                for item in items {
                    self.value(item);
                }
                let length = u32::try_from(self.buf.len() - start).unwrap_or(u32::MAX);
                self.buf[length_at..length_at + 4].copy_from_slice(&length.to_le_bytes());
            }
            Value::Struct(fields) => {
                self.pad(8);
                for field in fields {
                    self.value(field);
                }
            }
            Value::Entry(key, value) => {
                self.pad(8);
                self.value(key);
                self.value(value);
            }
            Value::Variant(inner) => {
                self.value(&Value::Sig(inner.signature()));
                self.value(inner);
            }
        }
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    big_endian: bool,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], big_endian: bool) -> Self {
        Self {
            buf,
            pos: 0,
            big_endian,
        }
    }

    fn align(&mut self, align: usize) -> io::Result<()> {
        let padding = (align - self.pos % align) % align;
        self.take(padding).map(|_| ())
    }

    fn take(&mut self, len: usize) -> io::Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(len)
            .filter(|end| *end <= self.buf.len())
            .ok_or_else(|| invalid("message truncated"))?;
        let bytes = &self.buf[self.pos..end];
        self.pos = end;
        Ok(bytes)
    }

    fn fixed<const N: usize>(&mut self) -> io::Result<[u8; N]> {
        self.align(N)?;
        let mut bytes: [u8; N] = self.take(N)?.try_into().expect("took exactly N bytes");
        if self.big_endian {
            bytes.reverse();
        }
        Ok(bytes)
    }

    fn u32(&mut self) -> io::Result<u32> {
        self.fixed::<4>().map(u32::from_le_bytes)
    }

    fn string(&mut self, len: usize) -> io::Result<String> {
        let bytes = self.take(len + 1)?;
        if bytes[len] != 0 {
            return Err(invalid("string not nul-terminated"));
        }
        String::from_utf8(bytes[..len].to_vec()).map_err(|_| invalid("string is not UTF-8"))
    }

    /// Reads one value of the single complete type `ty`.
    pub fn value(&mut self, ty: &str, depth: usize) -> io::Result<Value> {
        if depth > MAX_DEPTH {
            return Err(invalid("value nests too deeply"));
        }
        let Some(first) = ty.as_bytes().first() else {
            return Err(invalid("empty type"));
        };
        Ok(match first {
            b'y' => Value::Byte(self.take(1)?[0]),
            b'b' => Value::Bool(self.u32()? != 0),
            b'n' => Value::I16(i16::from_le_bytes(self.fixed::<2>()?)),
            b'q' => Value::U16(u16::from_le_bytes(self.fixed::<2>()?)),
            b'i' => Value::I32(i32::from_le_bytes(self.fixed::<4>()?)),
            b'u' => Value::U32(self.u32()?),
            b'h' => Value::Fd(self.u32()?),
            b'x' => Value::I64(i64::from_le_bytes(self.fixed::<8>()?)),
            b't' => Value::U64(u64::from_le_bytes(self.fixed::<8>()?)),
            b'd' => Value::F64(f64::from_le_bytes(self.fixed::<8>()?)),
            b's' | b'o' => {
                let len = self.u32()? as usize;
                let text = self.string(len)?;
                if *first == b's' {
                    Value::Str(text)
                } else {
                    Value::Path(text)
                }
            }
            b'g' => {
                let len = usize::from(self.take(1)?[0]);
                Value::Sig(self.string(len)?)
            }
            b'a' => {
                let len = self.u32()? as usize;
                let element = &ty[1..];
                self.align(alignment(element))?;
                if element == "y" {
                    return Ok(Value::Bytes(self.take(len)?.to_vec()));
                }
                let end = self
                    .pos
                    .checked_add(len)
                    .filter(|end| *end <= self.buf.len())
                    .ok_or_else(|| invalid("array overruns the message"))?;
                let mut items = Vec::new();
                while self.pos < end {
                    items.push(self.value(element, depth + 1)?);
                }
                if self.pos != end {
                    return Err(invalid("array length mismatch"));
                }
                Value::Array(element.to_string(), items)
            }
            b'(' => {
                self.align(8)?;
                let mut rest = &ty[1..ty.len() - 1];
                let mut fields = Vec::new();
                while !rest.is_empty() {
                    let (field, tail) = split_first(rest)?;
                    fields.push(self.value(field, depth + 1)?);
                    rest = tail;
                }
                Value::Struct(fields)
            }
            b'{' => {
                self.align(8)?;
                let inner = &ty[1..ty.len() - 1];
                let (key, rest) = split_first(inner)?;
                let (value, _) = split_first(rest)?;
                Value::Entry(
                    Box::new(self.value(key, depth + 1)?),
                    Box::new(self.value(value, depth + 1)?),
                )
            }
            b'v' => {
                let Value::Sig(signature) = self.value("g", depth)? else {
                    unreachable!("reading a signature yields a signature");
                };
                let (inner, rest) = split_first(&signature)?;
                if !rest.is_empty() {
                    return Err(invalid("variant holds more than one type"));
                }
                Value::Variant(Box::new(self.value(inner, depth + 1)?))
            }
            _ => return Err(invalid("unknown type")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    MethodCall = 1,
    MethodReturn = 2,
    Error = 3,
    Signal = 4,
}

pub const NO_REPLY_EXPECTED: u8 = 0x1;

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub kind: Kind,
    pub flags: u8,
    pub serial: u32,
    pub path: Option<String>,
    pub interface: Option<String>,
    pub member: Option<String>,
    pub error_name: Option<String>,
    pub reply_serial: Option<u32>,
    pub destination: Option<String>,
    pub sender: Option<String>,
    pub body: Vec<Value>,
}

impl Message {
    fn new(kind: Kind) -> Self {
        Self {
            kind,
            flags: 0,
            serial: 0,
            path: None,
            interface: None,
            member: None,
            error_name: None,
            reply_serial: None,
            destination: None,
            sender: None,
            body: Vec::new(),
        }
    }

    pub fn method_call(
        destination: &str,
        path: &str,
        interface: &str,
        member: &str,
        body: Vec<Value>,
    ) -> Self {
        Self {
            destination: Some(destination.into()),
            path: Some(path.into()),
            interface: Some(interface.into()),
            member: Some(member.into()),
            body,
            ..Self::new(Kind::MethodCall)
        }
    }

    pub fn signal(path: &str, interface: &str, member: &str, body: Vec<Value>) -> Self {
        Self {
            path: Some(path.into()),
            interface: Some(interface.into()),
            member: Some(member.into()),
            body,
            ..Self::new(Kind::Signal)
        }
    }

    pub fn method_return(call: &Message, body: Vec<Value>) -> Self {
        Self {
            destination: call.sender.clone(),
            reply_serial: Some(call.serial),
            body,
            ..Self::new(Kind::MethodReturn)
        }
    }

    pub fn error(call: &Message, name: &str, text: &str) -> Self {
        Self {
            destination: call.sender.clone(),
            reply_serial: Some(call.serial),
            error_name: Some(name.into()),
            body: vec![Value::str(text)],
            ..Self::new(Kind::Error)
        }
    }

    pub fn expects_reply(&self) -> bool {
        self.kind == Kind::MethodCall && self.flags & NO_REPLY_EXPECTED == 0
    }

    pub fn encode(&self, serial: u32) -> Vec<u8> {
        let mut body = Writer::default();
        for value in &self.body {
            body.value(value);
        }
        let signature: String = self.body.iter().map(Value::signature).collect();

        let mut fields = Vec::new();
        let mut field = |code: u8, value: Value| {
            fields.push(Value::Struct(vec![
                Value::Byte(code),
                Value::variant(value),
            ]));
        };
        if let Some(path) = &self.path {
            field(1, Value::Path(path.clone()));
        }
        if let Some(interface) = &self.interface {
            field(2, Value::str(interface));
        }
        if let Some(member) = &self.member {
            field(3, Value::str(member));
        }
        if let Some(name) = &self.error_name {
            field(4, Value::str(name));
        }
        if let Some(reply) = self.reply_serial {
            field(5, Value::U32(reply));
        }
        if let Some(destination) = &self.destination {
            field(6, Value::str(destination));
        }
        if let Some(sender) = &self.sender {
            field(7, Value::str(sender));
        }
        if !signature.is_empty() {
            field(8, Value::Sig(signature));
        }

        let mut out = Writer::default();
        out.buf.extend([b'l', self.kind as u8, self.flags, 1]);
        out.u32(u32::try_from(body.buf.len()).unwrap_or(u32::MAX));
        out.u32(serial);
        out.value(&Value::Array("(yv)".into(), fields));
        out.pad(8);
        out.buf.extend(body.buf);
        out.buf
    }

    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        let big_endian = match bytes.first() {
            Some(b'l') => false,
            Some(b'B') => true,
            _ => return Err(invalid("bad endianness marker")),
        };
        if bytes.len() < 16 || bytes[3] != 1 {
            return Err(invalid("bad header"));
        }
        let kind = match bytes[1] {
            1 => Kind::MethodCall,
            2 => Kind::MethodReturn,
            3 => Kind::Error,
            4 => Kind::Signal,
            _ => return Err(invalid("unknown message type")),
        };
        let mut reader = Reader::new(bytes, big_endian);
        reader.pos = 4;
        let body_len = reader.u32()? as usize;
        let serial = reader.u32()?;
        let fields = reader.value("a(yv)", 0)?;
        reader.align(8)?;
        if bytes.len() - reader.pos != body_len {
            return Err(invalid("body length mismatch"));
        }

        let mut message = Self {
            flags: bytes[2],
            serial,
            ..Self::new(kind)
        };
        let mut signature = String::new();
        for field in fields.as_array().unwrap_or_default() {
            let Value::Struct(parts) = field else {
                continue;
            };
            let [Value::Byte(code), Value::Variant(value)] = parts.as_slice() else {
                continue;
            };
            match (code, value.as_ref()) {
                (1, Value::Path(v)) => message.path = Some(v.clone()),
                (2, Value::Str(v)) => message.interface = Some(v.clone()),
                (3, Value::Str(v)) => message.member = Some(v.clone()),
                (4, Value::Str(v)) => message.error_name = Some(v.clone()),
                (5, Value::U32(v)) => message.reply_serial = Some(*v),
                (6, Value::Str(v)) => message.destination = Some(v.clone()),
                (7, Value::Str(v)) => message.sender = Some(v.clone()),
                (8, Value::Sig(v)) => signature.clone_from(v),
                _ => {}
            }
        }

        let mut body = Reader::new(&bytes[reader.pos..], big_endian);
        let mut rest = signature.as_str();
        while !rest.is_empty() {
            let (ty, tail) = split_first(rest)?;
            message.body.push(body.value(ty, 0)?);
            rest = tail;
        }
        if body.pos != body_len {
            return Err(invalid("body has trailing bytes"));
        }
        Ok(message)
    }
}

pub fn read_message(stream: &mut impl Read) -> io::Result<Message> {
    let mut head = [0u8; 16];
    stream.read_exact(&mut head)?;
    let read_u32 = |at: usize| {
        let bytes: [u8; 4] = head[at..at + 4].try_into().expect("4 bytes");
        if head[0] == b'B' {
            u32::from_be_bytes(bytes)
        } else {
            u32::from_le_bytes(bytes)
        }
    };
    let body_len = read_u32(4) as usize;
    let fields_len = read_u32(12) as usize;
    let total = (16 + fields_len)
        .checked_next_multiple_of(8)
        .and_then(|header| header.checked_add(body_len))
        .filter(|total| *total <= MAX_MESSAGE_SIZE)
        .ok_or_else(|| invalid("message too large"))?;
    let mut buf = vec![0u8; total];
    buf[..16].copy_from_slice(&head);
    stream.read_exact(&mut buf[16..])?;
    Message::decode(&buf)
}

/// The sending half of a bus connection. Shared by the thread reading the
/// bus and by whatever thread has a change to announce.
pub struct Bus {
    writer: Mutex<UnixStream>,
    serial: AtomicU32,
}

impl Bus {
    /// Connects and authenticates; returns the bus and a separate handle to
    /// read incoming messages from.
    pub fn connect_session() -> io::Result<(Self, UnixStream)> {
        let stream = connect_session_bus()?;
        authenticate(&stream)?;
        let reader = stream.try_clone()?;
        Ok((
            Self {
                writer: Mutex::new(stream),
                serial: AtomicU32::new(1),
            },
            reader,
        ))
    }

    pub fn send(&self, message: &Message) -> io::Result<u32> {
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        let bytes = message.encode(serial);
        self.writer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .write_all(&bytes)?;
        Ok(serial)
    }
}

fn connect_session_bus() -> io::Result<UnixStream> {
    if let Ok(address) = env::var("DBUS_SESSION_BUS_ADDRESS") {
        for entry in address.split(';') {
            let Some(params) = entry.strip_prefix("unix:") else {
                continue;
            };
            for param in params.split(',') {
                if let Some(path) = param.strip_prefix("path=") {
                    return UnixStream::connect(unescape(path)?);
                }
                if let Some(name) = param.strip_prefix("abstract=") {
                    use std::os::linux::net::SocketAddrExt;
                    let address =
                        std::os::unix::net::SocketAddr::from_abstract_name(unescape(name)?)?;
                    return UnixStream::connect_addr(&address);
                }
            }
        }
    }
    let runtime = dirs::runtime_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no session bus address"))?;
    UnixStream::connect(runtime.join("bus"))
}

/// D-Bus addresses escape bytes as `%xx`.
fn unescape(value: &str) -> io::Result<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| invalid("bad escape"))?;
            let text = std::str::from_utf8(hex).map_err(|_| invalid("bad escape"))?;
            out.push(u8::from_str_radix(text, 16).map_err(|_| invalid("bad escape"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| invalid("address is not UTF-8"))
}

/// SASL EXTERNAL: the bus checks the uid we claim against the socket's
/// kernel-provided credentials, so there's no secret involved.
fn authenticate(stream: &UnixStream) -> io::Result<()> {
    let status = fs::read_to_string("/proc/self/status")?;
    let uid = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|ids| ids.split_whitespace().nth(1))
        .ok_or_else(|| invalid("no effective uid"))?;
    let hex_uid: String = uid.bytes().map(|b| format!("{b:02x}")).collect();
    let mut stream = stream;
    stream.write_all(format!("\0AUTH EXTERNAL {hex_uid}\r\n").as_bytes())?;

    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while !line.ends_with(b"\r\n") {
        if line.len() > 512 {
            return Err(invalid("auth reply too long"));
        }
        stream.read_exact(&mut byte)?;
        line.push(byte[0]);
    }
    if !line.starts_with(b"OK ") {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "session bus refused authentication: {}",
                String::from_utf8_lossy(&line).trim()
            ),
        ));
    }
    stream.write_all(b"BEGIN\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(value: Value) {
        let mut writer = Writer::default();
        writer.value(&value);
        let signature = value.signature();
        let mut reader = Reader::new(&writer.buf, false);
        assert_eq!(reader.value(&signature, 0).unwrap(), value, "{signature}");
        assert_eq!(reader.pos, writer.buf.len());
    }

    #[test]
    fn every_type_round_trips() {
        for value in [
            Value::Byte(7),
            Value::Bool(true),
            Value::I16(-3),
            Value::U16(3),
            Value::I32(-70000),
            Value::U32(70000),
            Value::I64(-1),
            Value::U64(1 << 40),
            Value::F64(1.5),
            Value::str("héllo"),
            Value::Path("/StatusNotifierItem".into()),
            Value::Sig("a{sv}".into()),
            Value::Bytes(vec![1, 2, 3]),
            Value::Array("s".into(), vec![]),
            Value::dict(vec![
                ("label", Value::str("Quit")),
                ("enabled", Value::Bool(false)),
            ]),
            Value::Struct(vec![Value::Byte(1), Value::U64(2), Value::str("x")]),
            Value::variant(Value::Array(
                "(iiay)".into(),
                vec![Value::Struct(vec![
                    Value::I32(2),
                    Value::I32(1),
                    Value::Bytes(vec![0, 1, 2, 3, 4, 5, 6, 7]),
                ])],
            )),
        ] {
            round_trip(value);
        }
    }

    /// The example message from the D-Bus specification's "Message Format"
    /// section is big-endian; this checks the layout of our little-endian
    /// encoding of an equivalent method call byte by byte, including header
    /// field padding and the body's 8-byte alignment.
    #[test]
    fn encodes_a_method_call_with_exact_padding() {
        let call = Message::method_call(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "Hello",
            vec![],
        );
        let bytes = call.encode(1);
        assert_eq!(&bytes[..4], b"l\x01\x00\x01");
        assert_eq!(&bytes[4..8], &0u32.to_le_bytes(), "empty body");
        assert_eq!(&bytes[8..12], &1u32.to_le_bytes(), "serial");
        assert_eq!(bytes.len() % 8, 0, "body starts 8-aligned");
        let decoded = Message::decode(&bytes).unwrap();
        assert_eq!(decoded.member.as_deref(), Some("Hello"));
        assert_eq!(decoded.destination.as_deref(), Some("org.freedesktop.DBus"));
        assert!(decoded.body.is_empty());
    }

    #[test]
    fn messages_round_trip_with_bodies() {
        let mut call = Message::method_call(
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            "org.kde.StatusNotifierWatcher",
            "RegisterStatusNotifierItem",
            vec![Value::str("org.kde.StatusNotifierItem-1-1")],
        );
        call.sender = Some(":1.42".into());
        let decoded = Message::decode(&call.encode(9)).unwrap();
        assert_eq!(decoded.serial, 9);
        assert_eq!(
            Message {
                serial: 9,
                ..call.clone()
            },
            decoded
        );

        let reply = Message::method_return(&decoded, vec![Value::U32(1), Value::dict(vec![])]);
        let decoded_reply = Message::decode(&reply.encode(10)).unwrap();
        assert_eq!(decoded_reply.reply_serial, Some(9));
        assert_eq!(decoded_reply.destination.as_deref(), Some(":1.42"));
        assert_eq!(decoded_reply.body, reply.body);
    }

    #[test]
    fn decodes_big_endian_messages() {
        // A signal with body (u 7, s "hi"), as a big-endian peer sends it.
        let mut bytes = vec![b'B', 4, 0, 1];
        bytes.extend(11u32.to_be_bytes()); // body length
        bytes.extend(3u32.to_be_bytes()); // serial
        bytes.extend(8u32.to_be_bytes()); // header fields length
        bytes.extend([8, 1, b'g', 0, 2, b'u', b's', 0]); // (SIGNATURE, v "us")
        bytes.extend(7u32.to_be_bytes());
        bytes.extend(2u32.to_be_bytes());
        bytes.extend(b"hi\0");

        let message = Message::decode(&bytes).unwrap();
        assert_eq!(message.kind, Kind::Signal);
        assert_eq!(message.serial, 3);
        assert_eq!(message.body, vec![Value::U32(7), Value::str("hi")]);
        assert!(
            Message::decode(&bytes[..bytes.len() - 1]).is_err(),
            "a short body is caught"
        );
    }

    #[test]
    fn signatures_split_into_complete_types() {
        assert_eq!(split_first("ia{sv}av").unwrap(), ("i", "a{sv}av"));
        assert_eq!(split_first("a{sv}av").unwrap(), ("a{sv}", "av"));
        assert_eq!(split_first("(ia{sv}av)u").unwrap(), ("(ia{sv}av)", "u"));
        for bad in ["", "a", "(", "()", "(i", "a{vs}", "a{s}", "a{sv", "z"] {
            assert!(split_first(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn hostile_input_is_rejected_without_panicking() {
        // Every signature a peer sends passes through `split_first`'s depth
        // check before anything is read with it.
        let too_deep = format!("{}i", "a".repeat(100));
        assert!(split_first(&too_deep).is_err());
        let deep = Message::signal(
            "/",
            "x.y",
            "Z",
            vec![Value::Array(too_deep[1..].to_string(), vec![])],
        );
        assert!(Message::decode(&deep.encode(1)).is_err());
        let deep_variant = Message::signal(
            "/",
            "x.y",
            "Z",
            vec![Value::variant(Value::Array(
                too_deep[1..].to_string(),
                vec![],
            ))],
        );
        assert!(Message::decode(&deep_variant.encode(1)).is_err());

        // An array claiming more bytes than the message has.
        let mut bytes = 1000u32.to_le_bytes().to_vec();
        bytes.extend([1, 2, 3, 4]);
        assert!(Reader::new(&bytes, false).value("ai", 0).is_err());

        // A string without its nul, and one that isn't UTF-8.
        let mut bytes = 2u32.to_le_bytes().to_vec();
        bytes.extend(b"hiX");
        assert!(Reader::new(&bytes, false).value("s", 0).is_err());
        let mut bytes = 2u32.to_le_bytes().to_vec();
        bytes.extend([0xff, 0xfe, 0]);
        assert!(Reader::new(&bytes, false).value("s", 0).is_err());

        for garbage in [
            &b""[..],
            b"x",
            b"l\x01\x00\x02",
            &[b'l', 9, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        ] {
            assert!(Message::decode(garbage).is_err());
        }

        let mut oversized = b"l\x01\x00\x01".to_vec();
        oversized.extend(u32::MAX.to_le_bytes());
        oversized.extend(1u32.to_le_bytes());
        oversized.extend(0u32.to_le_bytes());
        assert!(read_message(&mut oversized.as_slice()).is_err());
    }

    #[test]
    fn addresses_unescape() {
        assert_eq!(
            unescape("/run/user/1000/bus").unwrap(),
            "/run/user/1000/bus"
        );
        assert_eq!(unescape("/tmp/a%20b").unwrap(), "/tmp/a b");
        assert!(unescape("/tmp/%zz").is_err());
    }
}
