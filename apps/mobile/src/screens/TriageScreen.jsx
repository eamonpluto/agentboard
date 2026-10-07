// CrewBus M5 Triage screen — unacked inbox cards from GET /api/inbox,
// digest-first (subject/from/at + collapsed body). Offline acks enqueue for
// the explicit Queue retry — never auto-replayed. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, Button, TextInput, FlatList, StyleSheet } from 'react-native';

export function TriageScreen({ ctx }) {
  const [agent, setAgent] = React.useState('');
  const [agentToken, setAgentToken] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [status, setStatus] = React.useState('Enter your agent name, then load.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no connected route — pick one on Boards first');
    return ctx.apiFor(route);
  };

  const load = async () => {
    if (!agent.trim()) { setStatus('agent name required.'); return; }
    try {
      const data = await currentApi().fetchInbox(agent.trim(), { unacked: 1, limit: 50 });
      const list = Array.isArray(data) ? data : data.items || data.messages || [];
      ctx.cache.setInbox(agent.trim(), list);
      setItems(list);
      setStatus(`${list.length} unacked`);
    } catch (e) {
      const cached = ctx.cache.getInbox(agent.trim());
      setItems(cached || []);
      setStatus(`offline — showing cached inbox (${(cached || []).length}). Acks will queue.`);
    }
  };

  const ack = async (id) => {
    try {
      await currentApi().ack({ from: agent.trim(), agentToken, id });
      setItems((prev) => prev.filter((m) => (m.id || m.replyId) !== id));
    } catch {
      ctx.cache.enqueue({ kind: 'ack', from: agent.trim(), agentToken, id });
      setStatus('offline — ack queued. Retry it explicitly on the Queue screen.');
    }
  };

  return (
    <View style={styles.pad}>
      <Text>{status}</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={agent} onChangeText={setAgent} placeholder="agent name" />
        <TextInput style={styles.input} value={agentToken} onChangeText={setAgentToken} placeholder="abt-…" secureTextEntry />
        <Button title="Load" onPress={load} />
      </View>
      <FlatList
        data={items}
        keyExtractor={(m, i) => String(m.id || m.replyId || i)}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.head}>{item.subject || '(no subject)'} · {item.from} · {item.at || ''}</Text>
            <Text numberOfLines={2}>{item.body || item.digest || ''}</Text>
            <Button title="Ack" onPress={() => ack(item.id || item.replyId)} />
          </View>
        )}
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
