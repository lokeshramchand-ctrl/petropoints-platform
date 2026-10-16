import { can, type Permission } from '@petropoints/rbac';
import { useSession, useTheme } from '@petropoints/mobile-ui';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { usePos } from '../../src/pos-context';

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const t = useTheme();
  const { user } = useSession();
  const { pending } = usePos();
  // Tabs are hidden (not just disabled) when the role lacks the permission.
  const allowed = (p: Permission) => !!user && can(user.role, p);

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
        options={{
          title: 'Sale',
          tabBarIcon: icon('⛽'),
          href: allowed('points:earn') ? '/' : null,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: icon('🧾'),
          href: allowed('transaction:read') ? '/activity' : null,
        }}
      />
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: icon('📊'),
          href: allowed('report:read') ? '/dashboard' : null,
        }}
      />
      <Tabs.Screen
        name="device"
        options={{
          title: 'Device',
          tabBarIcon: icon('🖨️'),
          tabBarBadge: pending > 0 ? pending : undefined,
        }}
      />
    </Tabs>
  );
}
