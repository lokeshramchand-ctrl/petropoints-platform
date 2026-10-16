import { formatPoints, formatRupees } from '@petropoints/mobile-core';
import {
  Body,
  Card,
  ErrorBanner,
  Heading,
  Spinner,
  space,
  useSession,
  useTheme,
} from '@petropoints/mobile-ui';
import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { api } from '../../src/api';

function Tile({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <Card style={{ flex: 1, minWidth: '45%' }}>
      <Body muted>{label}</Body>
      <Text
        style={{ color: t.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] }}
      >
        {value}
      </Text>
    </Card>
  );
}

export default function Dashboard() {
  const t = useTheme();
  const { user } = useSession();
  const q = useQuery({
    queryKey: ['daily', user?.merchantId],
    queryFn: () => api.daily(user!.merchantId!, 7),
    enabled: !!user?.merchantId,
  });

  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];
  // the API buckets days in IST; compute "today" the same way (en-CA formats as YYYY-MM-DD)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const todayRow = rows.find((r) => r.day === today);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.lg }}
      refreshControl={
        <RefreshControl
          refreshing={q.isRefetching}
          onRefresh={() => void q.refetch()}
          tintColor={t.brand}
        />
      }
    >
      <ErrorBanner error={q.error} />
      <Heading size={18}>Today</Heading>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <Tile label="Fuel sales" value={formatRupees(todayRow?.salesPaise ?? 0)} />
        <Tile label="Transactions" value={formatPoints(todayRow?.transactions ?? 0)} />
        <Tile label="Points issued" value={formatPoints(todayRow?.earned ?? 0)} />
        <Tile label="Points redeemed" value={formatPoints(todayRow?.redeemed ?? 0)} />
      </View>

      <Heading size={18}>Last 7 days</Heading>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <Tile label="Fuel sales" value={formatRupees(sum((r) => r.salesPaise))} />
        <Tile label="Transactions" value={formatPoints(sum((r) => r.transactions))} />
      </View>

      <Card style={{ gap: space.sm }}>
        {rows.length === 0 && <Body muted>No activity in the last 7 days.</Body>}
        {[...rows].reverse().map((r) => (
          <View key={r.day} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Body>{r.day.slice(5)}</Body>
            <Body muted>
              {formatRupees(r.salesPaise)} · +{formatPoints(r.earned)} / −{formatPoints(r.redeemed)}{' '}
              pts
            </Body>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}
