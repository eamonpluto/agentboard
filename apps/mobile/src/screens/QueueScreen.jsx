// CrewBus M5 Queue screen — explicit manual retry of offline queued mutations. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconZap, IconAlert } from '../components/Icons.jsx';
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
          <TouchableOpacity style={[STYLES.btnPrimary, styles.btnRow, { opacity: pending.length ? 1 : 0.5 }]} disabled={!pending.length} onPress={retryAll}>
            <IconZap size={14} color="#08130f" />
            <Text style={STYLES.btnText}>Retry All Queued ({pending.length})</Text>
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
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <Text style={STYLES.textMuted}>Attempts: {item.attempts}</Text>
                  {item.lastError ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      <Text style={STYLES.textMuted}>·</Text>
                      <IconAlert size={12} color={THEME.amber} />
                      <Text style={[STYLES.textMuted, { color: THEME.amber }]}>{item.lastError}</Text>
                    </View>
                  ) : null}
                </View>
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
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  qCard: { padding: 12, gap: 8, marginVertical: 4 },
  empty: { color: THEME.textSubtle, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
