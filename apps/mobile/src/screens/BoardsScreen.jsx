// CrewBus M5 Boards screen — route/env picker from learned + advertised
// routes, board snapshot, connection dot. JSX: excluded from `node --check`.
import React from 'react';
import { View, Text, Button, TextInput, FlatList, StyleSheet } from 'react-native';

export function BoardsScreen({ ctx }) {
  const [routes, setRoutes] = React.useState([]);
  const [board, setBoard] = React.useState(null);
  const [status, setStatus] = React.useState('Add a relay route or pick a learned one.');
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
    <View style={styles.pad}>
      <Text>connection: {conn}{preferred ? ` · learned: ${preferred}` : ''}</Text>
      <Text>{status}</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="https://relay:port" />
        <Button title="Add" onPress={addRoute} />
      </View>
      <FlatList
        data={routes}
        keyExtractor={(r) => r}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.grow}>{item}{item === preferred ? ' ★' : ''}</Text>
            <Button title="Use" onPress={() => useRoute(item)} />
          </View>
        )}
      />
      {board ? <Text>board: {JSON.stringify(board.name || board).slice(0, 120)}</Text> : null}
      <Button title="Refresh connection" onPress={() => { ctx.connection.retryNow(); refreshConn(); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  input: { flex: 1, borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 8 },
  grow: { flex: 1 },
});
