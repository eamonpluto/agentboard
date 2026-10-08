// CrewBus M5 Queue screen — explicit manual retry of offline queued mutations. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { describeOp } from '../lib/queue.js';
import { ROUTES } from '../navigation/routes.js';

export function QueueScreen({ ctx, navigation }) {
  const [pending, setPending] = React.useState(ctx.cache.pending());
  const [status, setStatus] = React.useState('Explicit retry executor for offline operations.');

  const refresh = () => setPending(ctx.cache.pending());

  const retryAll = async () => {
    setStatus(`retrying ${ctx.cache.pending().length} mutations…`);
    const results = await ctx.cache.retryAll(ctx.queueWorker);
    const failed = results.filter((r) => !r.ok);
    setStatus(failed.length ? `${failed.length} still failing — retained in queue` : 'All operations executed successfully');
    refresh();
  };

  const retryOne = async (id) => {
    const res = await ctx.cache.retry(id, ctx.queueWorker);
    setStatus(res.ok ? `Executed ${id}` : `Kept in queue: ${res.error}`);
    refresh();
  };

  return (
    <View style={STYLES.screen}>
      <HeaderBar title="Offline Queue" statusText={status} navigation={navigation} rightTitle="Back" onRightPress={() => navigation.navigate(ROUTES.Boards)} />
      <View style={STYLES.body}>
        <View style={[STYLES.card, styles.topCard]}>
          <Text style={STYLES.cardTitle}>{pending.length} Queued Action{pending.length === 1 ? '' : 's'}</Text>
          <Text style={STYLES.cardSub}>Mutations never auto-replay. Tap below to flush to the relay.</Text>
          <TouchableOpacity style={[STYLES.btnPrimary, { opacity: pending.length ? 1 : 0.5 }]} disabled={!pending.length} onPress={retryAll}>
            <Text style={STYLES.btnText}>⚡ Retry All Queued ({pending.length})</Text>
          </TouchableOpacity>
        </View>
        <FlatList
          data={pending}
          keyExtractor={(q) => q.id}
          ListEmptyComponent={<Text style={styles.empty}>Queue is empty. Offline actions will stage here.</Text>}
          renderItem={({ item }) => (
            <View style={[STYLES.card, styles.qCard]}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={STYLES.cardTitle}>{describeOp(item.op)}</Text>
                <Text style={STYLES.textMuted}>Attempts: {item.attempts}{item.lastError ? ` · ⚠️ ${item.lastError}` : ''}</Text>
              </View>
              <View style={STYLES.row}>
                <TouchableOpacity style={STYLES.btnSecondary} onPress={() => retryOne(item.id)}><Text style={STYLES.btnText}>Retry</Text></TouchableOpacity>
                <TouchableOpacity style={STYLES.btnDanger} onPress={() => { ctx.cache.discard(item.id); refresh(); }}><Text style={[STYLES.btnText, { color: THEME.rose }]}>Discard</Text></TouchableOpacity>
              </View>
            </View>
          )}
        />
      </View>
      <BottomNav currentRoute={ROUTES.Boards} navigation={navigation} badgeQueue={pending.length} />
    </View>
  );
}

const styles = StyleSheet.create({
  topCard: { padding: 14, gap: 8 },
  qCard: { padding: 12, gap: 8, marginVertical: 4 },
  empty: { color: THEME.textSubtle, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
