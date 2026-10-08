// CrewBus M5 Pair screen — QR scan -> validate -> walk -> exchange.
// Env id only surfaced, no secrets logged. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { DEFAULT_PAIR_SCOPES } from '../auth/scopes.js';
import { parsePairInput, describePairUrl, walkPairRoutes, exchangeAndStore } from '../lib/pairing.js';
import { THEME, STYLES } from '../theme.js';
import { ROUTES } from '../navigation/routes.js';

export function PairScreen({ ctx, navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('Scan relay QR to link this device.');
  const [pairedEnv, setPairedEnv] = React.useState(null);

  React.useEffect(() => {
    const dev = ctx.authStore.getDevice();
    if (dev && dev.envId) setPairedEnv(dev.envId);
  }, []);

  const handleCode = async (data) => {
    if (busy) return;
    setBusy(true);
    setScanning(false);
    try {
      const parsed = parsePairInput(data);
      setStatus(`pairing with env ${parsed.env || '(unknown)'}…`);
      const won = await walkPairRoutes(parsed.routes, ctx.connection.probe, { learned: ctx.connection.learned });
      if (!won.ok) { setStatus(`no route worked (${won.reason}). Check relay.`); return; }
      const api = ctx.apiFor(won.route);
      ctx.connection.updateRoutes(parsed.routes);
      const summary = await exchangeAndStore({
        api, pairToken: parsed.pairToken, label: 'mobile',
        scopes: [...DEFAULT_PAIR_SCOPES], envId: parsed.env, authStore: ctx.authStore,
      });
      setPairedEnv(summary.envId || '(paired)');
      setStatus(`paired as ${summary.deviceId}`);
    } catch (e) {
      setStatus(`rejected: ${String((e && e.message) || e)}`);
    } finally { setBusy(false); }
  };

  const clearAll = async () => {
    await ctx.authStore.clear();
    setPairedEnv(null);
    setStatus('Scan relay QR to link this device.');
  };
  void describePairUrl;

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: THEME.bg }}>
        <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(ev) => handleCode(ev.data)} />
        <TouchableOpacity style={styles.cancelBtn} onPress={() => setScanning(false)}><Text style={STYLES.btnText}>Cancel</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[STYLES.screen, { justifyContent: 'center', padding: 20 }]}>
      <View style={[STYLES.card, { padding: 20, alignItems: 'center', gap: 14 }]}>
        <Text style={{ color: THEME.text, fontSize: 20, fontWeight: '800' }}>{pairedEnv ? 'Device Paired' : 'Link CrewBus'}</Text>
        <Text style={STYLES.textMuted}>{status}</Text>
        {pairedEnv ? (
          <View style={{ alignItems: 'center', gap: 12, marginVertical: 8 }}>
            <View style={{ padding: 12, backgroundColor: THEME.cardElevated, borderRadius: 12, borderWidth: 1, borderColor: THEME.border }}>
              <QRCode value={pairedEnv} size={110} backgroundColor="transparent" color={THEME.text} />
            </View>
            <Text style={{ color: THEME.emerald, fontSize: 13, fontWeight: '600' }}>Env: {pairedEnv}</Text>
            {navigation ? (
              <TouchableOpacity style={[STYLES.btnPrimary, { width: '100%', paddingVertical: 11 }]} onPress={() => navigation.navigate(ROUTES.Triage)}>
                <Text style={STYLES.btnText}>Open Activity Feed →</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        {!permission || !permission.granted ? (
          <TouchableOpacity style={[STYLES.btnPrimary, { width: '100%', paddingVertical: 11 }]} onPress={requestPermission}><Text style={STYLES.btnText}>Grant Camera Permission</Text></TouchableOpacity>
        ) : (
          <TouchableOpacity style={[STYLES.btnPrimary, { width: '100%', paddingVertical: 11 }]} disabled={busy} onPress={() => setScanning(true)}>
            <Text style={STYLES.btnText}>{busy ? 'Connecting…' : (pairedEnv ? 'Scan Different QR' : 'Scan Pair QR')}</Text>
          </TouchableOpacity>
        )}
        {pairedEnv ? (
          <TouchableOpacity style={[STYLES.btnSecondary, { width: '100%', paddingVertical: 11 }]} onPress={clearAll}>
            <Text style={[STYLES.btnText, { color: THEME.rose }]}>Disconnect Device</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cancelBtn: { position: 'absolute', bottom: 30, alignSelf: 'center', backgroundColor: THEME.cardElevated, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
});
