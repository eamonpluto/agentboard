// CrewBus M5 Mobile persistent bottom navigation bar.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ROUTES } from '../navigation/routes.js';
import { THEME } from '../theme.js';

const TABS = [
  { route: ROUTES.Triage, label: 'Feed', icon: '⚡' },
  { route: ROUTES.Launch, label: 'Launch', icon: '🚀' },
  { route: ROUTES.Approvals, label: 'Approvals', icon: '🛡️' },
  { route: ROUTES.Fleet, label: 'Fleet', icon: '👥' },
  { route: ROUTES.Boards, label: 'Hub', icon: '⚙️' },
];

export function BottomNav({ currentRoute, navigation, badgeApprovals = 0, badgeQueue = 0 }) {
  if (!navigation) return null;
  return (
    <View style={styles.bar}>
      {TABS.map((tab) => {
        const active = currentRoute === tab.route;
        const badge = tab.route === ROUTES.Approvals ? badgeApprovals : (tab.route === ROUTES.Boards ? badgeQueue : 0);
        return (
          <TouchableOpacity
            key={tab.route}
            style={[styles.tab, active && styles.activeTab]}
            onPress={() => navigation.navigate(tab.route)}
            activeOpacity={0.7}
          >
            <View style={styles.iconWrap}>
              <Text style={styles.icon}>{tab.icon}</Text>
              {badge > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.label, active && styles.activeLabel]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: THEME.cardElevated,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    paddingTop: 6,
    paddingBottom: 16,
    paddingHorizontal: 6,
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    borderRadius: 8,
  },
  activeTab: {
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
  },
  iconWrap: { position: 'relative' },
  icon: { fontSize: 16 },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    backgroundColor: THEME.rose,
    borderRadius: 10,
    paddingHorizontal: 4,
    paddingVertical: 1,
    minWidth: 16,
    alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  label: {
    color: THEME.textSubtle,
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  activeLabel: {
    color: THEME.primaryLight,
    fontWeight: '700',
  },
});
