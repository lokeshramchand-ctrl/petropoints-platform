import { useTheme } from '@petropoints/mobile-ui';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Points', tabBarIcon: icon('⛽'), tabBarAccessibilityLabel: 'Points' }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'Activity',
          tabBarIcon: icon('🧾'),
          tabBarAccessibilityLabel: 'Activity',
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: icon('👤'), tabBarAccessibilityLabel: 'Profile' }}
      />
    </Tabs>
  );
}
