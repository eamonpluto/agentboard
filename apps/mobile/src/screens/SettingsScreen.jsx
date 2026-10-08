// CrewBus M5 Settings screen — device identity, learned routes, sign-out. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconDevice, IconPackage } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

export function SettingsScreen({ ctx, navigation }) {
  const [devices, setDevices] = React.useState(null);
  const [agent, setAgent] = React.useState('mobile');
  const [agentToken, setAgentToken] = React.useState('');
  const [status, setStatus] = React.useState('Device and relay configuration.');
  const learned = ctx.connection.learned.snapshot();
  const stats = ctx.cache.stats();
  const device = ctx.authStore.getDevice();

  const reviewDevices = async () => {
    const route = ctx.connection.getState().route;
    if (!route) { setStatus('connect a route in Hub first.'); return; }
    try {
      setDevices(await ctx.apiFor(route).fetchDevices({ from: agent.trim(), agentToken }));
      setStatus('device list is admin-gated');
    } catch (e) { setStatus(`devices unavailable: ${String((e && e.message) || e)}`); }
  };

  const signOut = async () => {
    await ctx.authStore.clear();
    setDevices(null);
    setStatus('Signed out — credentials wiped.');
    if (navigation) navigation.navigate(ROUTES.Pair);
  };

  return (
    <View style={STYLES.screen}>
      <HeaderBar title="Device & Hub" statusText={status} navigation={navigation} rightTitle="Queue" onRightPress={() => navigation.navigate(ROUTES.Queue)} />
      <View style={STYLES.body}>
        <View style={STYLES.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <IconDevice size={16} color={THEME.primaryLight} />
            <Text style={STYLES.cardTitle}>Device Identity</Text>
          </View>
          <Text style={STYLES.textMuted}>{device ? `${device.deviceId} (env: ${device.envId || 'none'})` : 'No device paired'}</Text>
          {device && device.scopes ? <Text style={styles.scopeTag}>Scopes: {device.scopes.join(', ')}</Text> : null}
        </View>
        <View style={STYLES.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <IconPackage size={16} color={THEME.primaryLight} />
            <Text style={STYLES.cardTitle}>Offline Cache</Text>
          </View>
          <Text style={STYLES.textMuted}>{stats.inboxes} inboxes · {stats.drafts} drafts · {stats.queued} queued mutations</Text>
        </View>
        <Text style={styles.head}>Learned Relay Routes</Text>
        <FlatList
          data={learned}
          keyExtractor={(r) => r.route}
          renderItem={({ item }) => <Text style={styles.routeItem}>• {item.route}</Text>}
          ListEmptyComponent={<Text style={STYLES.textMuted}>No learned routes recorded yet.</Text>}
        />
        <View style={STYLES.row}>
          <TextInput style={[STYLES.input, { flex: 1 }]} value={agent} onChangeText={setAgent} placeholder="admin agent" placeholderTextColor={THEME.textSubtle} />
          <TouchableOpacity style={STYLES.btnSecondary} onPress={reviewDevices}><Text style={STYLES.btnText}>Audit</Text></TouchableOpacity>
        </View>
        <TouchableOpacity style={STYLES.btnDanger} onPress={signOut}>
          <Text style={[STYLES.btnText, { color: THEME.rose }]}>Sign Out & Wipe Credentials</Text>
        </TouchableOpacity>
      </View>
      <BottomNav currentRoute={ROUTES.Boards} navigation={navigation} badgeQueue={stats.queued} />
    </View>
  );
}

const styles = StyleSheet.create({
  scopeTag: { color: THEME.primaryLight, fontSize: 11, marginTop: 4 },
  head: { color: THEME.text, fontWeight: '700', fontSize: 13, marginTop: 4 },
  routeItem: { color: THEME.textMuted, fontSize: 12, paddingVertical: 2 },
});
