// CrewBus M5 mobile biometric secure-store adapter.
// Implements the runtime `{ get, set, del }` async-string interface
// (packages/client-runtime/auth.js) over expo-secure-store, which binds to
// the iOS keychain / Android keystore. Pass `requireAuthentication: true`
// (with an `authenticationPrompt`) to gate reads behind biometrics; the
// default below stores without a per-read prompt but still in hardware
// keystore storage, never in AsyncStorage. No secrets ever hit console/logs.
import * as SecureStore from 'expo-secure-store';

export const DEVICE_STORE_KEY = 'crewbus.device';
export const KEY_PREFIX = 'crewbus.';

export function secureStoreOptions({ requireAuthentication = false, authenticationPrompt = 'Unlock CrewBus credentials' } = {}) {
  const opts = {};
  if (requireAuthentication) {
    opts.requireAuthentication = true;
    opts.authenticationPrompt = authenticationPrompt;
  }
  return opts;
}

export function createSecureStoreAdapter({ prefix = KEY_PREFIX, options = {}, requireAuthentication = false, authenticationPrompt = 'Unlock CrewBus credentials' } = {}) {
  // Top-level biometric flags are shorthand for secureStoreOptions(...):
  // explicit `options` win when both are given, default stays off (store
  // in hardware keystore storage without a per-read prompt).
  const effective = { ...secureStoreOptions({ requireAuthentication, authenticationPrompt }), ...options };
  const keyOf = (key) => `${prefix}${String(key)}`;
  return {
    async get(key) {
      try {
        const value = await SecureStore.getItemAsync(keyOf(key), { ...effective });
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await SecureStore.setItemAsync(keyOf(key), String(value), { ...effective });
    },
    async del(key) {
      try {
        await SecureStore.deleteItemAsync(keyOf(key), { ...effective });
      } catch {
        // Already gone counts as deleted (sign-out must never fail).
      }
    },
  };
}
