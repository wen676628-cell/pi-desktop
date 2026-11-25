//! One writer per data directory.
//!
//! Two host processes over the same directory — the Dev build's shared-data
//! mode, a second launch that raced the single-instance lock, a manual CLI
//! start — can interleave a migration with multi-statement session writes.
//! SQLite keeps the file itself consistent, but the invariants above it
//! (schema version, transcript/outbox pairing, run claims) are not SQLite's to
//! keep. Take an exclusive advisory lease on the directory before opening the
//! database and refuse to boot while another host holds it.
//!
//! The lease lives on `pi.writer.lock`, not on `pi.sqlite`: the memory server
//! and analysis tools read the database without taking a write lease, and a
//! lock on the database file itself would also collide with backup copies.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

const LOCK_FILE: &str = "pi.writer.lock";

/// First byte the exclusive range starts at (see the Windows lock below).
#[cfg(windows)]
const HOLDER_BYTES: u32 = 4096;

/// Held for the lifetime of the owning state; dropping it releases the lease.
pub struct DataDirLease {
    file: File,
    #[allow(dead_code)]
    path: PathBuf,
}

impl DataDirLease {
    /// Acquire the lease or explain who already holds it.
    pub fn acquire(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("create data directory {}", data_dir.display()))?;
        let path = data_dir.join(LOCK_FILE);
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("open writer lease {}", path.display()))?;
        lock_exclusive(&file).map_err(|error| match read_holder(&path) {
            Some(holder) => anyhow!(
                "DATA_DIR_IN_USE: {} is already open by {holder}",
                data_dir.display()
            ),
            None => anyhow!(
                "DATA_DIR_IN_USE: {} is already open by another process ({error})",
                data_dir.display()
            ),
        })?;
        write_holder(&mut file);
        Ok(Self { file, path })
    }
}

impl Drop for DataDirLease {
    fn drop(&mut self) {
        unlock(&self.file);
    }
}

impl std::fmt::Debug for DataDirLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DataDirLease")
            .field("path", &self.path)
            .finish()
    }
}

fn write_holder(file: &mut File) {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown host".to_string());
    let holder = format!("PI-Desktop host (pid {}, {host})", std::process::id());
    let _ = file.set_len(0);
    let _ = file.seek(SeekFrom::Start(0));
    let _ = file.write_all(holder.as_bytes());
    let _ = file.flush();
}

fn read_holder(path: &Path) -> Option<String> {
    let mut content = String::new();
    File::open(path).ok()?.read_to_string(&mut content).ok()?;
    let holder = content.trim();
    if holder.is_empty() {
        None
    } else {
        Some(holder.to_string())
    }
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> std::io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock(file: &File) {
    use std::os::unix::io::AsRawFd;
    unsafe {
        libc::flock(file.as_raw_fd(), libc::LOCK_UN);
    }
}

#[cfg(windows)]
fn lock_exclusive(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    // The refusal message has to be readable by the process that lost the
    // race, and a locked byte range cannot be read through a second handle.
    // Lock everything past the holder line instead of the whole file.
    overlapped.Anonymous.Anonymous.Offset = HOLDER_BYTES;
    let acquired = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    };
    if acquired != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn unlock(file: &File) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.Anonymous.Anonymous.Offset = HOLDER_BYTES;
    unsafe {
        UnlockFileEx(file.as_raw_handle() as HANDLE, 0, 1, 0, &mut overlapped);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_writer_is_refused_and_the_directory_reopens_after_release() {
        let dir = tempfile::tempdir().unwrap();
        let lease = DataDirLease::acquire(dir.path()).unwrap();

        let error = DataDirLease::acquire(dir.path()).unwrap_err().to_string();
        assert!(
            error.contains("DATA_DIR_IN_USE"),
            "refusal must name the condition: {error}"
        );
        assert!(
            error.contains(&format!("pid {}", std::process::id())),
            "refusal must name the holder: {error}"
        );

        drop(lease);
        DataDirLease::acquire(dir.path()).expect("a released directory must reopen");
    }

    #[test]
    fn an_empty_lease_file_still_refuses_without_a_holder_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(LOCK_FILE), b"").unwrap();
        let lease = DataDirLease::acquire(dir.path()).unwrap();
        let error = DataDirLease::acquire(dir.path()).unwrap_err().to_string();
        assert!(error.contains("DATA_DIR_IN_USE"));
        drop(lease);
    }
}
