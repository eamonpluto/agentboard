// CrewBus M5 Mobile unified HeaderBar.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { THEME } from '../theme.js';
import { ROUTES } from '../navigation/routes.js';
import { IconSettings } from './Icons.jsx';

export function HeaderBar({ title, statusText, connState = 'connected', navigation, rightTitle, onRightPress }) {
  const dotColor = connState === 'connected' ? THEME.emerald : (connState === 'probing' ? THEME.amber : THEME.rose);
  return (
    <View style={styles.header}>
      <View style={styles.left}>
        <View style={styles.titleRow}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text style={styles.title}>{title}</Text>
        </View>
        {statusText ? <Text style={styles.subtitle} numberOfLines={1}>{statusText}</Text> : null}
      </View>
      <View style={styles.right}>
        {rightTitle && onRightPress ? (
          <TouchableOpacity style={styles.rightBtn} onPress={onRightPress} activeOpacity={0.7}>
            <Text style={styles.rightBtnText}>{rightTitle}</Text>
          </TouchableOpacity>
        ) : navigation ? (
          <TouchableOpacity
            style={styles.rightBtn}
            onPress={() => navigation.navigate(ROUTES.Settings)}
            activeOpacity={0.7}
          >
            <IconSettings size={15} color={THEME.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: THEME.cardElevated,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { color: THEME.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: THEME.textMuted, fontSize: 11, marginTop: 2 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rightBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rightBtnText: { color: THEME.textMuted, fontSize: 12, fontWeight: '600' },
});
