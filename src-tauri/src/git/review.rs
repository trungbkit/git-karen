// Reading files for review: history and blame that follow renames, and file contents at a revision as bytes
// for image diffs.
use std::path::Path;

use super::exec::{git_bytes, Opts};
use super::parse::{parse_blame_porcelain, parse_follow_paths, parse_log, LOG_FORMAT};
use super::service::{GitService, Res};
use crate::types::*;

/// Largest file an image diff loads (each side), in bytes.
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (for `data:` URLs).
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

impl GitService {
    /// Commits touching `path` (newest first), following renames, with the file's path in each commit.
    pub async fn file_history(&self, repo: &str, path: &str, limit: Option<u32>) -> Res<Vec<FileHistoryCommit>> {
        let n = format!("-n{}", limit.unwrap_or(500));
        let log = [a(&["log", "--follow", "--decorate=full"]), vec![format!("--format={LOG_FORMAT}"), n.clone()], a(&["HEAD", "--", path])];
        let names = [a(&["-c", "core.quotepath=false", "log", "--follow", "--name-status", "-z", "--format=%x1e%H"]), vec![n], a(&["HEAD", "--", path])];
        let (commits, names) = tokio::join!(self.out(repo, log.concat()), self.out(repo, names.concat()));
        let paths = parse_follow_paths(&names?, path);
        Ok(parse_log(&commits?)
            .into_iter()
            .map(|commit| {
                let (path, old_path) = match paths.iter().find(|(sha, ..)| *sha == commit.sha) {
                    Some((_, p, old)) => (p.clone(), old.clone()),
                    None => (path.to_string(), None),
                };
                FileHistoryCommit { commit, path, old_path }
            })
            .collect())
    }

    /// Blame of `path` at `rev` (the working copy without one). `-M -C` attributes moved and copied lines to the
    /// commit that wrote them, in whichever file that was.
    pub async fn blame(&self, repo: &str, path: &str, rev: Option<String>) -> Res<Vec<BlameLine>> {
        let mut args = a(&["-c", "core.quotepath=false", "blame", "--porcelain", "-M", "-C"]);
        args.extend(rev.filter(|r| !r.is_empty()));
        args.extend(a(&["--", path]));
        Ok(parse_blame_porcelain(&self.out(repo, args).await?))
    }

    /// The file's bytes as base64: in the working copy (`rev` None), the index (`rev` ""), or a revision.
    /// None when the file does not exist there.
    pub async fn image_blob(&self, repo: &str, rev: Option<String>, path: &str) -> Res<Option<ImageBlob>> {
        let too_large = |size: u64| format!("{path} is too large to preview ({} MB)", size / (1024 * 1024));
        let bytes = match rev {
            None => {
                let file = Path::new(repo).join(path);
                match tokio::fs::metadata(&file).await {
                    Err(_) => return Ok(None),
                    Ok(m) if m.len() > MAX_IMAGE_BYTES => return Err(too_large(m.len())),
                    Ok(_) => tokio::fs::read(&file).await.map_err(|e| format!("{path}: {e}"))?,
                }
            }
            Some(rev) => {
                let object = format!("{rev}:{path}");
                let size = self.read(repo, a(&["cat-file", "-s", &object]), &[0, 128]).await?;
                if size.code != 0 {
                    return Ok(None);
                }
                let size: u64 = size.stdout.trim().parse().unwrap_or(0);
                if size > MAX_IMAGE_BYTES {
                    return Err(too_large(size));
                }
                git_bytes(Path::new(repo), &a(&["cat-file", "blob", &object]), Opts::read()).await?.stdout
            }
        };
        Ok(Some(ImageBlob { base64: base64(&bytes), size: bytes.len() as u64 }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_with_padding() {
        let cases = [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")];
        for (raw, enc) in cases {
            assert_eq!(base64(raw.as_bytes()), enc);
        }
        assert_eq!(base64(&[0, 255, 254, 128]), "AP/+gA==");
    }
}
