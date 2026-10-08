// CrewBus M5 Mobile persistent bottom navigation bar.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ROUTES } from '../navigation/routes.js';
import { THEME } from '../theme.js';
import { IconFeed, IconLaunch, IconApprovals, IconFleet, IconSettings } from './Icons.jsx';

const TABS = [
  { route: ROUTES.Triage, label: 'Feed', Icon: IconFeed },
  { route: ROUTES.Launch, label: 'Launch', Icon: IconLaunch },
  { route: ROUTES.Approvals, label: 'Approvals', Icon: IconApprovals },
  { route: ROUTES.Fleet, label: 'Fleet', Icon: IconFleet },
  { route: ROUTES.Boards, label: 'Hub', Icon: IconSettings },
];

export function BottomNav({ currentRoute, navigation, badgeApprovals = 0, badgeQueue = 0 }) {
  if (!navigation) return null;
  return (
    <View style={styles.bar}>
      {TABS.map((tab) => {
        const active = currentRoute === tab.route;
        const badge = tab.route === ROUTES.Approvals ? badgeApprovals : (tab.route === ROUTES.Boards ? badgeQueue : 0);
        const TabIcon = tab.Icon;
        const iconColor = active ? THEME.primaryLight : THEME.textSubtle;
        return (
          <TouchableOpacity
            key={tab.route}
            style={[styles.tab, active && styles.activeTab]}
            onPress={() => navigation.navigate(tab.route)}
            activeOpacity={0.7}
          >
            <View style={styles.iconWrap}>
              <TabIcon size={19} color={iconColor} />
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
    paddingTop: 8,
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
    marginTop: 4,
  },
  activeLabel: {
    color: THEME.primaryLight,
    fontWeight: '700',
  },
});
