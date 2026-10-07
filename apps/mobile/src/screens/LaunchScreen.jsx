// CrewBus M5 Launch screen — harness picker (GET /api/harnesses), count +
// brief + permission, dry-run preview DEFAULT, explicit live confirm.
// Nothing launches without the two-step confirm. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, Button, TextInput, FlatList, StyleSheet } from 'react-native';

const PERMISSIONS = ['supervised', 'autoEdits', 'auto', 'full'];

export function LaunchScreen({ ctx }) {
  const [harnesses, setHarnesses] = React.useState([]);
  const [harness, setHarness] = React.useState(null);
  const [count, setCount] = React.useState(1);
  const [brief, setBrief] = React.useState('');
  const [permission, setPermission] = React.useState('supervised');
  const [from, setFrom] = React.useState('');
  const [agentToken, setAgentToken] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const [status, setStatus] = React.useState('Pick a harness, then preview a dry-run.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no connected route — pick one on Boards first');
    return ctx.apiFor(route);
  };

  const loadHarnesses = async () => {
    try {
      const data = await currentApi().fetchHarnesses();
      const list = Array.isArray(data) ? data : data.harnesses || data.items || [];
      setHarnesses(list);
      setStatus(`${list.length} harnesses`);
    } catch (e) {
      setStatus(`offline: ${String((e && e.message) || e)}`);
    }
  };

  const payload = () => ({ from: from.trim(), token: agentToken, harness, count, body: brief, permission });

  const doPreview = async () => {
    try {
      const res = await currentApi().launch(payload());
      setPreview(res);
      setStatus('dry-run preview ready — review before confirming live.');
    } catch (e) {
      setStatus(`preview failed: ${String((e && e.message) || e)}`);
    }
  };

  const doLive = async () => {
    try {
      const res = await currentApi().launch({ ...payload(), dryRun: false });
      setStatus(`launched: ${res.crewId || res.batch || 'ok'}`);
      setPreview(null);
    } catch (e) {
      setStatus(`launch failed: ${String((e && e.message) || e)}`);
    }
  };

  return (
    <View style={styles.pad}>
      <Text>{status}</Text>
      <Button title="Detect harnesses" onPress={loadHarnesses} />
      <FlatList
        horizontal
        data={harnesses}
        keyExtractor={(h, i) => String(h.driver || h.name || i)}
        renderItem={({ item }) => (
          <Text style={item === harness ? styles.sel : styles.opt} onPress={() => setHarness(item)}>
            {String(item.displayName || item.driver || item.name)}
          </Text>
        )}
      />
      <View style={styles.row}>
        <Button title="-" onPress={() => setCount((c) => Math.max(1, c - 1))} />
        <Text>count: {count}</Text>
        <Button title="+" onPress={() => setCount((c) => Math.min(20, c + 1))} />
      </View>
      <TextInput style={styles.box} value={brief} onChangeText={setBrief} placeholder="task brief" multiline />
      <View style={styles.row}>
        <TextInput style={styles.opt} value={from} onChangeText={setFrom} placeholder="agent name" />
        <TextInput style={styles.opt} value={agentToken} onChangeText={setAgentToken} placeholder="abt-…" secureTextEntry />
      </View>
      <View style={styles.row}>
        {PERMISSIONS.map((p) => (
          <Text key={p} style={p === permission ? styles.sel : styles.opt} onPress={() => setPermission(p)}>{p}</Text>
        ))}
      </View>
      <Button title="Preview dry-run" disabled={!harness || !brief.trim()} onPress={doPreview} />
      {preview ? <Text numberOfLines={6}>{JSON.stringify(preview).slice(0, 600)}</Text> : null}
      <Button title="Confirm LIVE launch" disabled={!preview} onPress={doLive} />
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  box: { borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 8, minHeight: 70 },
  opt: { padding: 8, margin: 2, borderWidth: 1, borderColor: '#888', borderRadius: 6 },
  sel: { padding: 8, margin: 2, borderWidth: 2, borderColor: '#06c', borderRadius: 6, fontWeight: 'bold' },
});
