// CrewBus M5 mobile stack navigator — explicit @react-navigation/native-stack
// (NOT expo-router: no file-convention Metro plugin, trivial entry, manual
// `crewbus://pair` deep-link handling). JSX: excluded from `node --check`.
import React from 'react';
import { Button } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ROUTES, INITIAL_ROUTE, ROUTE_TITLES } from './routes.js';
import { PairScreen } from '../screens/PairScreen.jsx';
import { BoardsScreen } from '../screens/BoardsScreen.jsx';
import { TriageScreen } from '../screens/TriageScreen.jsx';
import { ApprovalsScreen } from '../screens/ApprovalsScreen.jsx';
import { LaunchScreen } from '../screens/LaunchScreen.jsx';
import { FleetScreen } from '../screens/FleetScreen.jsx';
import { QueueScreen } from '../screens/QueueScreen.jsx';
import { SettingsScreen } from '../screens/SettingsScreen.jsx';

const Stack = createNativeStackNavigator();

const SCREENS = {
  [ROUTES.Pair]: PairScreen,
  [ROUTES.Boards]: BoardsScreen,
  [ROUTES.Triage]: TriageScreen,
  [ROUTES.Approvals]: ApprovalsScreen,
  [ROUTES.Launch]: LaunchScreen,
  [ROUTES.Fleet]: FleetScreen,
  [ROUTES.Queue]: QueueScreen,
  [ROUTES.Settings]: SettingsScreen,
};

const ORDER = [
  ROUTES.Pair,
  ROUTES.Boards,
  ROUTES.Triage,
  ROUTES.Approvals,
  ROUTES.Launch,
  ROUTES.Fleet,
  ROUTES.Queue,
  ROUTES.Settings,
];

export function RootNavigator({ ctx }) {
  return (
    <Stack.Navigator initialRouteName={INITIAL_ROUTE}>
      {ORDER.map((name) => {
        const Screen = SCREENS[name];
        return (
          <Stack.Screen
            key={name}
            name={name}
            options={({ navigation }) => ({
              title: ROUTE_TITLES[name],
              headerRight:
                name === ROUTES.Settings
                  ? undefined
                  : () => <Button title="Settings" onPress={() => navigation.navigate(ROUTES.Settings)} />,
            })}
          >
            {() => <Screen ctx={ctx} />}
          </Stack.Screen>
        );
      })}
    </Stack.Navigator>
  );
}
