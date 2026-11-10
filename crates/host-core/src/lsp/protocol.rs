//! LSP base-protocol framing: `Content-Length: N\r\n\r\n<json>`.
//!
//! The reader is incremental because a child process writes in arbitrary
//! chunks. A malformed header is drained and reported instead of stalling the
//! caller forever; a body larger than the cap is treated as a protocol error.

const HEADER_END: &[u8] = b"\r\n\r\n";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    MissingContentLength,
    InvalidContentLength,
    TooLarge,
}

#[derive(Debug, Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Returns the next complete body, `None` while more bytes are needed, or a
    /// protocol error. On error the offending header is dropped so the next
    /// call can resynchronize.
    pub fn next_frame(&mut self) -> Option<Result<Vec<u8>, FrameError>> {
        let header_end = find(&self.buffer, HEADER_END)?;
        let header = &self.buffer[..header_end];
        let mut seen_length = false;
        let mut length: Option<usize> = None;
        for line in header.split(|byte| *byte == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let Some(colon) = line.iter().position(|byte| *byte == b':') else {
                continue;
            };
            let (name, value) = line.split_at(colon);
            if name.eq_ignore_ascii_case(b"content-length") {
                seen_length = true;
                length = std::str::from_utf8(&value[1..])
                    .ok()
                    .and_then(|text| text.trim().parse::<usize>().ok());
            }
        }
        let Some(length) = length else {
            self.buffer.drain(..header_end + HEADER_END.len());
            return Some(Err(if seen_length {
                FrameError::InvalidContentLength
            } else {
                FrameError::MissingContentLength
            }));
        };
        if length > MAX_FRAME_BYTES {
            self.buffer.drain(..header_end + HEADER_END.len());
            return Some(Err(FrameError::TooLarge));
        }
        let body_start = header_end + HEADER_END.len();
        if self.buffer.len() < body_start + length {
            return None;
        }
        let body = self.buffer[body_start..body_start + length].to_vec();
        self.buffer.drain(..body_start + length);
        Some(Ok(body))
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn encode_message(body: &[u8]) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_reads_one_frame() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let mut reader = FrameReader::new();
        reader.push(&encode_message(body));
        assert_eq!(reader.next_frame(), Some(Ok(body.to_vec())));
        assert_eq!(reader.next_frame(), None);
    }

    #[test]
    fn buffers_a_frame_split_across_chunks() {
        let frame = encode_message(b"{\"a\":1}");
        let mut reader = FrameReader::new();
        reader.push(&frame[..5]);
        assert_eq!(reader.next_frame(), None);
        reader.push(&frame[5..]);
        assert_eq!(reader.next_frame(), Some(Ok(b"{\"a\":1}".to_vec())));
    }

    #[test]
    fn reads_two_frames_back_to_back() {
        let mut bytes = encode_message(b"one");
        bytes.extend_from_slice(&encode_message(b"two"));
        let mut reader = FrameReader::new();
        reader.push(&bytes);
        assert_eq!(reader.next_frame(), Some(Ok(b"one".to_vec())));
        assert_eq!(reader.next_frame(), Some(Ok(b"two".to_vec())));
        assert_eq!(reader.next_frame(), None);
    }

    #[test]
    fn accepts_lowercase_header_names() {
        let mut reader = FrameReader::new();
        reader.push(b"content-length: 2\r\n\r\n{}");
        assert_eq!(reader.next_frame(), Some(Ok(b"{}".to_vec())));
    }

    #[test]
    fn reports_a_missing_content_length_and_resynchronizes() {
        let mut reader = FrameReader::new();
        reader.push(b"X-Other: 1\r\n\r\n");
        assert_eq!(
            reader.next_frame(),
            Some(Err(FrameError::MissingContentLength))
        );
        reader.push(&encode_message(b"ok"));
        assert_eq!(reader.next_frame(), Some(Ok(b"ok".to_vec())));
    }

    #[test]
    fn rejects_a_non_numeric_content_length() {
        let mut reader = FrameReader::new();
        reader.push(b"Content-Length: nope\r\n\r\n");
        assert_eq!(
            reader.next_frame(),
            Some(Err(FrameError::InvalidContentLength))
        );
    }

    #[test]
    fn rejects_an_oversized_body() {
        let mut reader = FrameReader::new();
        reader.push(b"Content-Length: 999999999\r\n\r\n");
        assert_eq!(reader.next_frame(), Some(Err(FrameError::TooLarge)));
    }
}
