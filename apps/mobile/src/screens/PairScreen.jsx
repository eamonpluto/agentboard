// CrewBus M5 Pair screen — QR scan → fragment-rule validate → route walk →
// exchange → biometric store. The full pair URL is NEVER logged/persisted;
// status surfaces show the env id only. JSX: excluded from `node --check`.
import React from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { DEFAULT_PAIR_SCOPES } from '../auth/scopes.js';
import { parsePairInput, describePairUrl, walkPairRoutes, exchangeAndStore } from '../lib/pairing.js';

export function PairScreen({ ctx }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('Point the camera at the relay QR.');
  const [pairedEnv, setPairedEnv] = React.useState(null);

  const handleCode = async (data) => {
    if (busy) return;
    setBusy(true);
    setScanning(false);
    try {
      const parsed = parsePairInput(data);
      setStatus(`pairing with env ${parsed.env || '(unknown env)'}…`);
      const won = await walkPairRoutes(parsed.routes, ctx.connection.probe, {
        learned: ctx.connection.learned,
      });
      if (!won.ok) {
        setStatus(`no route worked (${won.reason}). Check the relay address.`);
        return;
      }
      const api = ctx.apiFor(won.route);
      ctx.connection.updateRoutes(parsed.routes);
      const summary = await exchangeAndStore({
        api,
        pairToken: parsed.pairToken,
        label: 'mobile',
        scopes: [...DEFAULT_PAIR_SCOPES],
        envId: parsed.env,
        authStore: ctx.authStore,
      });
      setPairedEnv(summary.envId || '(paired)');
      setStatus(`paired as ${summary.deviceId} via ${won.route}`);
    } catch (e) {
      setStatus(`rejected: ${String((e && e.message) || e)}`);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = () => {
    setStatus('Point the camera at the relay QR.');
    setPairedEnv(null);
  };
  void describePairUrl;

  if (scanning) {
    return (
      <View style={styles.fill}>
        <CameraView
          style={styles.fill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(ev) => handleCode(ev.data)}
        />
        <Button title="Cancel" onPress={() => setScanning(false)} />
      </View>
    );
  }
  return (
    <View style={styles.pad}>
      <Text style={styles.status}>{status}</Text>
      {/* Non-secret echo ONLY: the QR encodes the env id for the success
          card (README rule). The pair URL / fragment secret is NEVER
          rendered, logged, or persisted — see handleCode/clearAll. */}
      {pairedEnv ? <Text>Env: {pairedEnv} (id only — secret stays in secure storage)</Text> : null}
      {pairedEnv ? <QRCode value={pairedEnv} size={120} /> : null}
      {!permission || !permission.granted ? (
        <Button title="Allow camera" onPress={requestPermission} />
      ) : (
        <Button title={busy ? 'Working…' : 'Scan pair QR'} disabled={busy} onPress={() => setScanning(true)} />
      )}
      <Button title="Clear" onPress={clearAll} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pad: { flex: 1, padding: 16, gap: 12 },
  status: { fontSize: 15 },
});
