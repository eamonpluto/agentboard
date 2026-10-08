// CrewBus M5 Launch screen — multi-harness & model chips, brief, preview & live. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { THEME, STYLES } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconZap, IconLaunch } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

const PERMS = ['supervised', 'autoEdits', 'auto', 'full'];
const MODELS = [{ id: '', l: 'Default' }, { id: 'claude-3-7-sonnet', l: '3.7 Sonnet' }, { id: 'gemini-2.5-pro', l: 'Gemini 2.5' }, { id: 'o3-mini', l: 'o3-mini' }, { id: 'grok-3', l: 'Grok 3' }];

export function LaunchScreen({ ctx, navigation }) {
  const [harnesses, setHarnesses] = React.useState([]);
  const [selected, setSelected] = React.useState(['claude']);
  const [model, setModel] = React.useState('');
  const [count, setCount] = React.useState(1);
  const [brief, setBrief] = React.useState('');
  const [permission, setPermission] = React.useState('supervised');
  const [preview, setPreview] = React.useState(null);
  const [status, setStatus] = React.useState('Configure multi-harness launch & preview.');

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
      setStatus(`${list.length} harnesses available`);
    } catch { setStatus('offline — harness detection failed'); }
  };

  React.useEffect(() => { loadHarnesses().catch(() => null); }, []);

  const toggleHarness = (d) => {
    setSelected((prev) => {
      const next = prev.includes(d) ? (prev.length > 1 ? prev.filter((x) => x !== d) : prev) : [...prev, d];
      setCount(next.length);
      return next;
    });
  };

  const payload = () => ({ from: 'mobile', token: '', harness: selected.join(','), harnesses: selected, model: model || undefined, count, body: brief, permission });

  const doPreview = async () => {
    try { setPreview(await currentApi().launch(payload())); setStatus('Dry-run preview ready.'); }
    catch (e) { setStatus(`preview failed: ${String((e && e.message) || e)}`); }
  };

  const doLive = async () => {
    try {
      const res = await currentApi().launch({ ...payload(), dryRun: false });
      setStatus(`Launched: ${res.crewId || res.batch || (res.workers && res.workers.length + ' workers') || 'ok'}`);
      setPreview(null);
    } catch (e) { setStatus(`launch failed: ${String((e && e.message) || e)}`); }
  };

  const harnessList = harnesses.length ? harnesses : [{ name: 'claude' }, { name: 'antigravity' }, { name: 'codex' }, { name: 'grok' }, { name: 'generic' }];

  return (
    <View style={STYLES.screen}>
      <HeaderBar title="Launch Task" statusText={status} navigation={navigation} rightTitle="Detect" onRightPress={loadHarnesses} />
      <ScrollView style={STYLES.body} contentContainerStyle={{ gap: 8, paddingBottom: 20 }}>
        <FlatList horizontal showsHorizontalScrollIndicator={false} data={harnessList} keyExtractor={(h, i) => String(h.driver || h.name || i)}
          renderItem={({ item }) => {
            const d = String(item.driver || item.name); const isSel = selected.includes(d);
            return (<TouchableOpacity style={[styles.chip, isSel && styles.chipSel]} onPress={() => toggleHarness(d)}><Text style={[styles.chipText, isSel && styles.chipTextSel]}>{d}</Text></TouchableOpacity>);
          }}
        />
        <FlatList horizontal showsHorizontalScrollIndicator={false} data={MODELS} keyExtractor={(m) => m.id || 'def'}
          renderItem={({ item }) => (<TouchableOpacity style={[styles.modelChip, model === item.id && styles.modelChipSel]} onPress={() => setModel(item.id)}><Text style={[styles.modelText, model === item.id && styles.modelTextSel]}>{item.l}</Text></TouchableOpacity>)}
        />
        <View style={STYLES.row}>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setCount((c) => Math.max(1, c - 1))}><Text style={STYLES.btnText}>-</Text></TouchableOpacity>
          <Text style={STYLES.text}>Workers: {count}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setCount((c) => Math.min(20, c + 1))}><Text style={STYLES.btnText}>+</Text></TouchableOpacity>
          <View style={{ flex: 1, flexDirection: 'row', gap: 4, justifyContent: 'flex-end' }}>
            {PERMS.map((p) => (<TouchableOpacity key={p} style={[styles.permChip, p === permission && styles.permChipSel]} onPress={() => setPermission(p)}><Text style={[styles.permText, p === permission && styles.permTextSel]}>{p}</Text></TouchableOpacity>))}
          </View>
        </View>
        <TextInput style={styles.briefInput} value={brief} onChangeText={setBrief} placeholder="Task instructions (Ctrl+Enter to launch)…" placeholderTextColor={THEME.textSubtle} multiline numberOfLines={3} />
        <TouchableOpacity style={STYLES.btnSecondary} disabled={!brief.trim()} onPress={doPreview}><Text style={STYLES.btnText}>Preview Dry-Run</Text></TouchableOpacity>
        {preview && (
          <View style={[STYLES.card, { borderColor: THEME.primary, gap: 6 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><IconZap size={14} color={THEME.primaryLight} /><Text style={{ color: THEME.primaryLight, fontSize: 12, fontWeight: '700' }}>Dry-Run Summary</Text></View>
            <Text style={STYLES.cardSub}>{preview.summary || `${count} worker(s) ready [${selected.join(', ')}]`}</Text>
            <TouchableOpacity style={[STYLES.btnPrimary, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }]} onPress={doLive}>
              <IconLaunch size={15} color="#08130f" /><Text style={STYLES.btnText}>Confirm LIVE Launch</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      <BottomNav currentRoute={ROUTES.Launch} navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6 },
  chipSel: { borderColor: THEME.primary, backgroundColor: 'rgba(99, 102, 241, 0.25)' },
  chipText: { color: THEME.textMuted, fontSize: 11, fontWeight: '600' },
  chipTextSel: { color: THEME.text, fontWeight: '700' },
  modelChip: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, marginRight: 6 },
  modelChipSel: { borderColor: THEME.amber, backgroundColor: 'rgba(245, 158, 11, 0.2)' },
  modelText: { color: THEME.textSubtle, fontSize: 10, fontWeight: '600' },
  modelTextSel: { color: THEME.amber, fontWeight: '700' },
  stepBtn: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 6, width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  permChip: { paddingHorizontal: 5, paddingVertical: 3, borderRadius: 6, backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border },
  permChipSel: { borderColor: THEME.emerald, backgroundColor: THEME.emeraldMuted },
  permText: { color: THEME.textSubtle, fontSize: 9, fontWeight: '600' },
  permTextSel: { color: THEME.emerald, fontWeight: '700' },
  briefInput: { backgroundColor: THEME.cardElevated, borderWidth: 1, borderColor: THEME.border, borderRadius: 8, padding: 8, color: THEME.text, minHeight: 75, textAlignVertical: 'top', fontSize: 12 },
});
