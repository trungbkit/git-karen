// Secrets in the OS credential store (macOS Keychain, Windows Credential Manager, Secret Service on Linux): hosting
// tokens, one entry per host, and AI provider keys, one entry per credential. Nothing here writes a secret to disk or
// hands it to the webview.

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// One service (a group of entries) in the OS credential store.
pub struct Keychain {
    service: &'static str,
    /// Where the entries lived before the app was renamed; moved to `service` the first time they're read.
    legacy: Option<&'static str>,
    /// What an entry is, for error messages: "the {noun} {account}"
    noun: &'static str,
}

impl Keychain {
    /// Hosting tokens, keyed by host.
    pub const HOSTING: Keychain = Keychain { service: "Karen hosting", legacy: Some("Kraken Craft hosting"), noun: "token for" };
    /// AI provider keys, keyed by credential name (`anthropicApiKey`, ...).
    pub const AI: Keychain = Keychain { service: "Karen AI", legacy: None, noun: "AI key" };

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.service, account).map_err(|e| format!("Keychain unavailable: {e}"))
    }

    fn take_legacy(&self, account: &str) -> Option<String> {
        let old = keyring::Entry::new(self.legacy?, account).ok()?;
        let secret = old.get_password().ok()?;
        if self.entry(account).and_then(|e| e.set_password(&secret).map_err(|e| e.to_string())).is_ok() {
            let _ = old.delete_credential();
        }
        Some(secret)
    }
}

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(self.take_legacy(account)),
            Err(e) => Err(format!("Could not read the {} {account} from the keychain: {e}", self.noun)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(secret)
            .map_err(|e| format!("Could not save the {} {account} in the keychain: {e}", self.noun))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        if let Some(Ok(old)) = self.legacy.map(|l| keyring::Entry::new(l, account)) {
            let _ = old.delete_credential();
        }
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Could not remove the {} {account} from the keychain: {e}", self.noun)),
        }
    }
}

/// In-memory store for tests (never touches the developer's keychain).
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(pub std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}
