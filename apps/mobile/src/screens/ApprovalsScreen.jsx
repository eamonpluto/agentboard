// CrewBus M5 Approvals screen — approve/deny with reason (deny requires
// one). Offline decisions enqueue for the explicit Queue retry. Approvals
// surface via the inbox (high-priority first); a dedicated endpoint is an
// M5b alignment item. JSX: excluded from `node --check`.
import React from 'react';
import { View, Text, Button, TextInput, FlatList, StyleSheet } from 'react-native';

function ApprovalCard({ item, onDecide }) {
  const [reason, setReason] = React.useState('');
  const id = item.id || item.replyId;
  return (
    <View style={styles.card}>
      <Text style={styles.head}>{item.subject || '(no subject)'} · {item.from}</Text>
      <Text numberOfLines={3}>{item.body || ''}</Text>
      <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="reason (required to deny)" />
      <View style={styles.row}>
        <Button title="Approve" onPress={() => onDecide(id, 'approve', reason)} />
        <Button title="Deny" onPress={() => onDecide(id, 'deny', reason)} />
      </View>
    </View>
  );
}

export function ApprovalsScreen({ ctx }) {
  const [agent, setAgent] = React.useState('');
  const [agentToken, setAgentToken] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [status, setStatus] = React.useState('Load the inbox, then decide each card.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no connected route — pick one on Boards first');
    return ctx.apiFor(route);
  };

  const load = async () => {
    try {
      const data = await currentApi().fetchInbox(agent.trim(), { unacked: 1, limit: 50 });
      const list = Array.isArray(data) ? data : data.items || data.messages || [];
      setItems(list);
      setStatus(`${list.length} awaiting decision`);
    } catch (e) {
      setStatus(`offline: ${String((e && e.message) || e)}`);
    }
  };

  const decide = async (id, decision, reason) => {
    if (decision === 'deny' && !reason.trim()) { setStatus('a reason is required to deny.'); return; }
    try {
      await currentApi().approve({ from: agent.trim(), agentToken, id, decision, reason });
      setItems((prev) => prev.filter((m) => (m.id || m.replyId) !== id));
      setStatus(`${decision}d ${id}`);
    } catch {
      ctx.cache.enqueue({ kind: 'approve', from: agent.trim(), agentToken, id, decision, reason });
      setStatus('offline — decision queued. Retry it explicitly on the Queue screen.');
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
        renderItem={({ item }) => <ApprovalCard item={item} onDecide={decide} />}
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
