// CrewBus M5 Queue screen — the ONLY executor of queued mutations.
// Explicit "Retry queued (n)" → cache.retryAll(worker). NEVER runs on
// reconnect or foreground refresh (spec §5: no mutation auto-replay).
// JSX: excluded from `node --check`.
import React from 'react';
import { View, Text, Button, FlatList, StyleSheet } from 'react-native';
import { describeOp } from '../lib/queue.js';

export function QueueScreen({ ctx }) {
  const [pending, setPending] = React.useState(ctx.cache.pending());
  const [status, setStatus] = React.useState('Queued work waits here until YOU retry it.');

  const refresh = () => setPending(ctx.cache.pending());

  const retryAll = async () => {
    setStatus(`retrying ${ctx.cache.pending().length}…`);
    const results = await ctx.cache.retryAll(ctx.queueWorker);
    const failed = results.filter((r) => !r.ok);
    setStatus(failed.length ? `${failed.length} still failing — kept queued.` : 'all retried.');
    refresh();
  };

  const retryOne = async (id) => {
    const res = await ctx.cache.retry(id, ctx.queueWorker);
    setStatus(res.ok ? `retried ${id}` : `kept queued: ${res.error}`);
    refresh();
  };

  return (
    <View style={styles.pad}>
      <Text>{status}</Text>
      <Button title={`Retry queued (${pending.length})`} disabled={!pending.length} onPress={retryAll} />
      <FlatList
        data={pending}
        keyExtractor={(q) => q.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text>{describeOp(item.op)} · attempts {item.attempts}</Text>
            {item.lastError ? <Text>last: {item.lastError}</Text> : null}
            <View style={styles.row}>
              <Button title="Retry" onPress={() => retryOne(item.id)} />
              <Button title="Discard" onPress={() => { ctx.cache.discard(item.id); refresh(); }} />
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, padding: 16, gap: 10 },
  row: { flexDirection: 'row', gap: 8 },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, marginVertical: 4, gap: 6 },
});
