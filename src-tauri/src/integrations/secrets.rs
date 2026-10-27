// Hosting tokens in the OS credential store (macOS Keychain, Windows Credential Manager, Secret Service on Linux),
// one entry per host. Nothing here writes a token to disk or hands it to the webview.
const SERVICE: &str = "Karen hosting";
/// Where tokens lived before the app was renamed; moved to SERVICE the first time they're read.
const LEGACY_SERVICE: &str = "Kraken Craft hosting";

pub trait SecretStore: Send + Sync {
    fn get(&self, host: &str) -> Result<Option<String>, String>;
    fn set(&self, host: &str, token: &str) -> Result<(), String>;
    fn delete(&self, host: &str) -> Result<(), String>;
}

pub struct Keychain;

fn entry(host: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, host).map_err(|e| format!("Keychain unavailable: {e}"))
}

fn take_legacy(host: &str) -> Option<String> {
    let old = keyring::Entry::new(LEGACY_SERVICE, host).ok()?;
    let token = old.get_password().ok()?;
    if entry(host).and_then(|e| e.set_password(&token).map_err(|e| e.to_string())).is_ok() {
        let _ = old.delete_credential();
    }
    Some(token)
}

impl SecretStore for Keychain {
    fn get(&self, host: &str) -> Result<Option<String>, String> {
        match entry(host)?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(take_legacy(host)),
            Err(e) => Err(format!("Could not read the token for {host} from the keychain: {e}")),
        }
    }

    fn set(&self, host: &str, token: &str) -> Result<(), String> {
        entry(host)?.set_password(token).map_err(|e| format!("Could not save the token for {host} in the keychain: {e}"))
    }

    fn delete(&self, host: &str) -> Result<(), String> {
        if let Ok(old) = keyring::Entry::new(LEGACY_SERVICE, host) {
            let _ = old.delete_credential();
        }
        match entry(host)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Could not remove the token for {host} from the keychain: {e}")),
        }
    }
}

/// In-memory store for tests (never touches the developer's keychain).
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(pub std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, host: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(host).cloned())
    }
    fn set(&self, host: &str, token: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(host.into(), token.into());
        Ok(())
    }
    fn delete(&self, host: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(host);
        Ok(())
    }
}
