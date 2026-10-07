// CrewBus M5 mobile entry — wiring only, no logic (logic lives in
// checkable src/*.js helpers; this JSX file is excluded from `node --check`).
// Remote-only v1: no local exec, no loopback, foreground refresh only.
import React from 'react';
import { AppState } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createCache, createAuthStore } from './src/vendor/runtime/index.js';
import { KNOWN_SCOPES } from './src/auth/scopes.js';
import { createSecureStoreAdapter, DEVICE_STORE_KEY } from './src/auth/secureStore.js';
import { createConnection, attachForegroundRefresh } from './src/lib/connection.js';
import { createApiClient } from './src/api/client.js';
import { createQueueWorker } from './src/lib/queue.js';
import { RootNavigator } from './src/navigation/RootNavigator.jsx';

function buildContext() {
  const secureAdapter = createSecureStoreAdapter();
  const authStore = createAuthStore({
    secureStore: secureAdapter,
    storeKey: DEVICE_STORE_KEY,
    knownScopes: [...KNOWN_SCOPES],
  });
  const cache = createCache();
  const connection = createConnection({ initialRoutes: [] });
  const apiFor = (route) =>
    createApiClient({ baseUrl: route, getCredential: () => authStore.getCredential() });
  const queueWorker = createQueueWorker({ apiFor, connection });
  return { authStore, cache, connection, apiFor, queueWorker };
}

const ctx = buildContext();

export default function App() {
  React.useEffect(() => {
    const detach = attachForegroundRefresh({
      AppState,
      supervisor: ctx.connection.supervisor,
      cache: ctx.cache,
    });
    ctx.authStore.restore().catch(() => null);
    return detach;
  }, []);
  return (
    <NavigationContainer>
      <RootNavigator ctx={ctx} />
    </NavigationContainer>
  );
}
