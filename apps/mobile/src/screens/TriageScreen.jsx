// CrewBus M5 Triage screen — unacked inbox feed cards with 1-tap ack. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconCheck } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

export function TriageScreen({ ctx, navigation }) {
  const [agent, setAgent] = React.useState('mobile');
  const [agentToken, setAgentToken] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [status, setStatus] = React.useState('Ready to sync inbox.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };

  const load = async () => {
    const target = agent.trim() || 'mobile';
    try {
      const data = await currentApi().fetchInbox(target, { unacked: 1, limit: 50 });
      const list = Array.isArray(data) ? data : data.items || data.messages || [];
      ctx.cache.setInbox(target, list);
      setItems(list);
      setStatus(`${list.length} unacked message${list.length === 1 ? '' : 's'}`);
    } catch {
      const cached = ctx.cache.getInbox(target) || [];
      setItems(cached);
      setStatus(`offline (${cached.length} cached)`);
    }
  };

  const ack = async (id) => {
    const target = agent.trim() || 'mobile';
    try {
      await currentApi().ack({ from: target, agentToken, id });
      setItems((prev) => prev.filter((m) => (m.id || m.replyId) !== id));
    } catch {
      ctx.cache.enqueue({ kind: 'ack', from: target, agentToken, id });
      setStatus('offline — ack queued for Queue retry');
    }
  };

  return (
    <View style={STYLES.screen}>
      <HeaderBar title="Activity Feed" statusText={status} navigation={navigation} rightTitle="Sync" onRightPress={load} />
      <View style={STYLES.body}>
        <View style={STYLES.row}>
          <TextInput style={[STYLES.input, { flex: 1 }]} value={agent} onChangeText={setAgent} placeholder="agent (default: mobile)" placeholderTextColor={THEME.textSubtle} />
          <TouchableOpacity style={STYLES.btnPrimary} onPress={load}><Text style={STYLES.btnText}>Load</Text></TouchableOpacity>
        </View>
        <FlatList
          data={items}
          keyExtractor={(m, i) => String(m.id || m.replyId || i)}
          ListEmptyComponent={<Text style={styles.empty}>All caught up! No unacked messages in inbox.</Text>}
          renderItem={({ item }) => (
            <View style={[STYLES.card, styles.msgCard]}>
              <View style={styles.msgHead}>
                <Text style={styles.senderPill}>@{item.from || 'agent'}</Text>
                <Text style={STYLES.textMuted}>{item.at ? item.at.slice(11, 19) : ''}</Text>
              </View>
              <Text style={STYLES.cardTitle}>{item.subject || '(no subject)'}</Text>
              <Text style={STYLES.cardSub} numberOfLines={3}>{item.body || item.digest || item.head || ''}</Text>
              <View style={styles.actionRow}>
                <TouchableOpacity style={[STYLES.btnSuccess, styles.ackBtn]} onPress={() => ack(item.id || item.replyId)}>
                  <IconCheck size={14} color={THEME.emerald} />
                  <Text style={[STYLES.btnText, { color: THEME.emerald }]}>Ack Message</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      </View>
      <BottomNav currentRoute={ROUTES.Triage} navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  msgCard: { padding: 12, gap: 6, marginVertical: 4 },
  msgHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  senderPill: { backgroundColor: 'rgba(99, 102, 241, 0.15)', color: THEME.primaryLight, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, fontSize: 11, fontWeight: '700' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  ackBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  empty: { color: THEME.textSubtle, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
