// CrewBus M5 Settings screen — routes, device lastSeen review hint, and
// sign-out (clears the biometric store AND memory). JSX: not `node --check`ed.
import React from 'react';
import { View, Text, Button, TextInput, FlatList, StyleSheet } from 'react-native';

export function SettingsScreen({ ctx }) {
  const [devices, setDevices] = React.useState(null);
  const [agent, setAgent] = React.useState('');
  const [agentToken, setAgentToken] = React.useState('');
  const [status, setStatus] = React.useState('Review routes and devices here.');
  const learned = ctx.connection.learned.snapshot();
  const stats = ctx.cache.stats();
  const device = ctx.authStore.getDevice();

  const reviewDevices = async () => {
    const route = ctx.connection.getState().route;
    if (!route) { setStatus('connect a route on Boards first.'); return; }
    try {
      setDevices(await ctx.apiFor(route).fetchDevices({ from: agent.trim(), agentToken }));
      setStatus('device list is admin-gated; revoke stale entries on the desktop/relay.');
    } catch (e) {
      setStatus(`devices unavailable: ${String((e && e.message) || e)}`);
    }
  };

  const signOut = async () => {
    await ctx.authStore.clear();
    setDevices(null);
    setStatus('signed out — device credential wiped from secure storage and memory.');
  };

  return (
    <View style={styles.pad}>
      <Text>{status}</Text>
      <Text>paired: {device ? `${device.deviceId} (${device.envId})` : 'none'}</Text>
      <Text>cache: {stats.inboxes} inboxes · {stats.drafts} drafts · {stats.queued} queued</Text>
      <Text style={styles.head}>Learned routes</Text>
      <FlatList data={learned} keyExtractor={(r) => r.route} renderItem={({ item }) => <Text>{item.route}</Text>} />
      <Button title="Review devices (lastSeen)" onPress={reviewDevices} />
      <View style={styles.row}>
        <TextInput style={styles.input} value={agent} onChangeText={setAgent} placeholder="admin agent" />
        <TextInput style={styles.input} value={agentToken} onChangeText={setAgentToken} placeholder="abt-…" secureTextEntry />
      </View>
      {devices ? <Text numberOfLines={6}>{JSON.stringify(devices).slice(0, 400)}</Text> : null}
      <Button title="Sign out (clears store)" onPress={signOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 8 },
  head: { fontWeight: 'bold', marginTop: 8 },
});
