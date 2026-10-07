// CrewBus M5 Fleet screen — worker cards with two-tap kill confirm.
// Offline kills enqueue for the explicit Queue retry. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, Button, TextInput, FlatList, StyleSheet } from 'react-native';

export function FleetScreen({ ctx }) {
  const [agent, setAgent] = React.useState('');
  const [agentToken, setAgentToken] = React.useState('');
  const [workers, setWorkers] = React.useState([]);
  const [armed, setArmed] = React.useState(null);
  const [status, setStatus] = React.useState('Load the fleet, then kill from a card.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no connected route — pick one on Boards first');
    return ctx.apiFor(route);
  };

  const load = async () => {
    try {
      const data = await currentApi().fetchFleet();
      setWorkers(Array.isArray(data) ? data : data.workers || data.items || []);
      setStatus(`${workers.length} workers`);
    } catch (e) {
      setStatus(`offline: ${String((e && e.message) || e)}`);
    }
  };

  const kill = async (name) => {
    if (armed !== name) { setArmed(name); setStatus(`tap Kill again to confirm ${name}`); return; }
    setArmed(null);
    try {
      await currentApi().kill({ from: agent.trim(), agentToken, to: [name] });
      setWorkers((prev) => prev.filter((w) => (w.name || w) !== name));
      setStatus(`killed ${name}`);
    } catch {
      ctx.cache.enqueue({ kind: 'kill', from: agent.trim(), agentToken, to: [name] });
      setStatus('offline — kill queued. Retry it explicitly on the Queue screen.');
    }
  };

  return (
    <View style={styles.pad}>
      <Text>{status}</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={agent} onChangeText={setAgent} placeholder="agent name" />
        <TextInput style={styles.input} value={agentToken} onChangeText={setAgentToken} placeholder="abt-…" secureTextEntry />
      </View>
      <Button title="Load fleet" onPress={load} />
      <FlatList
        data={workers}
        keyExtractor={(w, i) => String((w && w.name) || w || i)}
        renderItem={({ item }) => {
          const name = String((item && item.name) || item);
          return (
            <View style={styles.card}>
              <Text style={styles.head}>{name}{item && item.pid ? ` · pid ${item.pid}` : ''}</Text>
              <Button title={armed === name ? 'Confirm kill' : 'Kill'} onPress={() => kill(name)} />
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 8 },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, marginVertical: 4, gap: 6 },
  head: { fontWeight: 'bold' },
});
