// CrewBus M5 mobile device-credential store wiring.
// Imports the runtime core (never reimplements it) and binds the biometric
// adapter; scopes are passed explicitly (Metro-safe — see scopes.js).
import { createAuthStore } from '../vendor/runtime/index.js';
import { KNOWN_SCOPES } from './scopes.js';
import { createSecureStoreAdapter, DEVICE_STORE_KEY } from './secureStore.js';

export { DEVICE_STORE_KEY };

export function createMobileAuthStore({ secureAdapter = null, storeKey = DEVICE_STORE_KEY, scopes = null, requireAuthentication = false, authenticationPrompt = 'Unlock CrewBus credentials' } = {}) {
  // Biometric gating threads from the store creator into the default
  // adapter (off unless requested); an explicitly-passed secureAdapter is
  // used as-is. Adapter interface stays async { get, set, del }.
  const backing = secureAdapter ?? createSecureStoreAdapter({ requireAuthentication, authenticationPrompt });
  return createAuthStore({
    secureStore: backing,
    storeKey,
    knownScopes: scopes ? [...scopes] : [...KNOWN_SCOPES],
  });
}
