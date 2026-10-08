// CrewBus M5 Launch screen — harness chips, task brief, preview & live confirm. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconZap, IconLaunch } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

const PERMS = ['supervised', 'autoEdits', 'auto', 'full'];

export function LaunchScreen({ ctx, navigation }) {
  const [harnesses, setHarnesses] = React.useState([]);
  const [harness, setHarness] = React.useState(null);
  const [count, setCount] = React.useState(1);
  const [brief, setBrief] = React.useState('');
  const [permission, setPermission] = React.useState('supervised');
  const [preview, setPreview] = React.useState(null);
  const [status, setStatus] = React.useState('Configure launch and preview dry-run.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };

  const loadHarnesses = async () => {
    try {
      const data = await currentApi().fetchHarnesses();
      const list = Array.isArray(data) ? data : data.harnesses || data.items || [];
      setHarnesses(list);
      if (list.length && !harness) setHarness(list[0]);
      setStatus(`${list.length} harnesses available`);
    } catch { setStatus('offline — harness detection failed'); }
  };

  React.useEffect(() => { loadHarnesses().catch(() => null); }, []);
  const payload = () => ({ from: 'mobile', token: '', harness, count, body: brief, permission });

  const doPreview = async () => {
    try {
      const res = await currentApi().launch(payload());
      setPreview(res);
      setStatus('Dry-run preview ready. Review before booting.');
    } catch (e) { setStatus(`preview failed: ${String((e && e.message) || e)}`); }
  };

  const doLive = async () => {
    try {
      const res = await currentApi().launch({ ...payload(), dryRun: false });
      setStatus(`Launched: ${res.crewId || res.batch || 'ok'}`);
      setPreview(null);
    } catch (e) { setStatus(`launch failed: ${String((e && e.message) || e)}`); }
  };

  return (
    <View style={STYLES.screen}>
      <HeaderBar title="Launch Task" statusText={status} navigation={navigation} rightTitle="Harnesses" onRightPress={loadHarnesses} />
      <ScrollView style={STYLES.body} contentContainerStyle={{ gap: 10, paddingBottom: 20 }}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={harnesses.length ? harnesses : [{ name: 'antigravity' }, { name: 'claude' }, { name: 'grok' }, { name: 'generic' }]}
          keyExtractor={(h, i) => String(h.driver || h.name || i)}
          renderItem={({ item }) => {
            const label = String(item.displayName || item.driver || item.name);
            const sel = (harness && (harness.name || harness.driver)) === (item.name || item.driver);
            return (
              <TouchableOpacity style={[styles.chip, sel && styles.chipSel]} onPress={() => setHarness(item)}>
                <Text style={[styles.chipText, sel && styles.chipTextSel]}>{label}</Text>
              </TouchableOpacity>
            );
          }}
        />
        <View style={STYLES.row}>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setCount((c) => Math.max(1, c - 1))}><Text style={STYLES.btnText}>-</Text></TouchableOpacity>
          <Text style={STYLES.text}>Workers: {count}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setCount((c) => Math.min(20, c + 1))}><Text style={STYLES.btnText}>+</Text></TouchableOpacity>
          <View style={{ flex: 1, flexDirection: 'row', gap: 4, justifyContent: 'flex-end' }}>
            {PERMS.map((p) => (
              <TouchableOpacity key={p} style={[styles.permChip, p === permission && styles.permChipSel]} onPress={() => setPermission(p)}>
                <Text style={[styles.permText, p === permission && styles.permTextSel]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <TextInput style={styles.briefInput} value={brief} onChangeText={setBrief} placeholder="Describe task instructions or goals for crew workers…" placeholderTextColor={THEME.textSubtle} multiline numberOfLines={4} />
        <TouchableOpacity style={STYLES.btnSecondary} disabled={!brief.trim()} onPress={doPreview}><Text style={STYLES.btnText}>Preview Dry-Run</Text></TouchableOpacity>
        {preview ? (
          <View style={[STYLES.card, { borderColor: THEME.primary, gap: 8 }]}>
            <View style={styles.previewHead}><IconZap size={14} color={THEME.primaryLight} /><Text style={styles.previewTitle}>Dry-Run Summary</Text></View>
            <Text style={STYLES.cardSub}>{preview.summary || `${count} worker(s) ready under ${permission}`}</Text>
            <TouchableOpacity style={[STYLES.btnPrimary, styles.liveBtn]} onPress={doLive}>
              <IconLaunch size={15} color="#08130f" /><Text style={STYLES.btnText}>Confirm LIVE Launch</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
      <BottomNav currentRoute={ROUTES.Launch} navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6 },
  chipSel: { borderColor: THEME.primary, backgroundColor: 'rgba(99, 102, 241, 0.2)' },
  chipText: { color: THEME.textMuted, fontSize: 12, fontWeight: '600' },
  chipTextSel: { color: THEME.text, fontWeight: '700' },
  stepBtn: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 6, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  permChip: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6, backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border },
  permChipSel: { borderColor: THEME.emerald, backgroundColor: THEME.emeraldMuted },
  permText: { color: THEME.textSubtle, fontSize: 10, fontWeight: '600' },
  permTextSel: { color: THEME.emerald, fontWeight: '700' },
  briefInput: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 8, padding: 10, color: THEME.text, minHeight: 90, textAlignVertical: 'top', fontSize: 13 },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  previewTitle: { color: THEME.primaryLight, fontSize: 13, fontWeight: '700' },
  liveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
});
