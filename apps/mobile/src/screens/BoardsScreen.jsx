// CrewBus M5 Boards screen — route/env picker and board snapshot. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { ROUTES } from '../navigation/routes.js';

export function BoardsScreen({ ctx, navigation }) {
  const [routes, setRoutes] = React.useState([]);
  const [board, setBoard] = React.useState(null);
  const [status, setStatus] = React.useState('Add or select a relay route.');
  const [draft, setDraft] = React.useState('');
  const [conn, setConn] = React.useState('unknown');

  const refreshConn = () => setConn(ctx.connection.getState().state);
  const addRoute = () => {
    const r = draft.trim();
    if (!r) return;
    setRoutes((prev) => (prev.includes(r) ? prev : [...prev, r]));
    setDraft('');
  };

  const useRoute = async (route) => {
    setStatus(`probing ${route}…`);
    try {
      const api = ctx.apiFor(route);
      await api.fetchHealth();
      const snapshot = await api.fetchBoard();
      const advertised = await api.fetchRoutes().catch(() => null);
      const hints = (advertised && (advertised.advertisedRoutes || advertised.routes)) || [];
      setRoutes((prev) => [...new Set([...prev, ...hints])]);
      ctx.connection.updateRoutes([...new Set([...routes, route, ...hints])]);
      await ctx.connection.retryNow();
      setBoard(snapshot);
      setStatus(`connected: ${route}`);
    } catch (e) {
      setStatus(`unreachable: ${String((e && e.message) || e)}`);
    }
    refreshConn();
  };

  const preferred = ctx.connection.learned.preferred(routes);

  return (
    <View style={STYLES.screen}>
      <HeaderBar title="Relay Hub" statusText={status} connState={conn} navigation={navigation} />
      <View style={STYLES.body}>
        <View style={STYLES.row}>
          <TextInput style={[STYLES.input, { flex: 1 }]} value={draft} onChangeText={setDraft} placeholder="https://relay:port" placeholderTextColor={THEME.textSubtle} />
          <TouchableOpacity style={STYLES.btnPrimary} onPress={addRoute}><Text style={STYLES.btnText}>+ Add</Text></TouchableOpacity>
        </View>
        <FlatList
          data={routes}
          keyExtractor={(r) => r}
          ListEmptyComponent={<Text style={styles.empty}>No relay routes yet. Scan QR or enter URL above.</Text>}
          renderItem={({ item }) => (
            <View style={[STYLES.card, styles.routeCard]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.routeText} numberOfLines={1}>{item}</Text>
                {item === preferred ? <Text style={styles.prefTag}>★ Preferred Learned Route</Text> : null}
              </View>
              <TouchableOpacity style={STYLES.btnSecondary} onPress={() => useRoute(item)}>
                <Text style={STYLES.btnText}>Connect</Text>
              </TouchableOpacity>
            </View>
          )}
        />
        {board ? (
          <View style={STYLES.card}>
            <Text style={STYLES.cardTitle}>Board: {String(board.name || 'Local Board')}</Text>
            <Text style={STYLES.cardSub}>{board.workers ? `${Object.keys(board.workers).length} workers active` : 'Online'}</Text>
          </View>
        ) : null}
        <TouchableOpacity style={STYLES.btnSecondary} onPress={() => { ctx.connection.retryNow(); refreshConn(); }}>
          <Text style={STYLES.btnText}>⚡ Re-probe Connection</Text>
        </TouchableOpacity>
      </View>
      <BottomNav currentRoute={ROUTES.Boards} navigation={navigation} badgeQueue={ctx.cache.pending().length} />
    </View>
  );
}

const styles = StyleSheet.create({
  routeCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10 },
  routeText: { color: THEME.text, fontSize: 13, fontWeight: '600' },
  prefTag: { color: THEME.amber, fontSize: 11, marginTop: 2 },
  empty: { color: THEME.textSubtle, textAlign: 'center', marginTop: 30, fontSize: 13 },
});
