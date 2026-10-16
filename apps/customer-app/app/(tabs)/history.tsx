import type { TransactionView } from '@petropoints/contracts';
import { formatPoints, formatRupees } from '@petropoints/mobile-core';
import { Body, Card, ErrorBanner, Pill, Spinner, space, useTheme } from '@petropoints/mobile-ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../../src/api';

const LABEL: Record<TransactionView['type'], string> = {
  EARN: 'Earned',
  REDEEM: 'Redeemed',
  REVERSAL: 'Reversed',
  ADJUSTMENT: 'Adjustment',
  EXPIRY: 'Expired',
};

const date = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

export default function History() {
  const t = useTheme();
  const router = useRouter();
  const q = useInfiniteQuery({
    queryKey: ['history'],
    queryFn: ({ pageParam }) => api.history(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (q.isLoading) return <Spinner />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm }}
      data={items}
      keyExtractor={(i) => i.id}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      refreshControl={
        <RefreshControl
          refreshing={q.isRefetching && !q.isFetchingNextPage}
          onRefresh={() => void q.refetch()}
          tintColor={t.brand}
        />
      }
      ListHeaderComponent={<ErrorBanner error={q.error} />}
      ListEmptyComponent={
        <Body muted style={{ textAlign: 'center', marginTop: 40 }}>
          No activity yet. Earn points at any partner petrol bunk.
        </Body>
      }
      ListFooterComponent={
        q.isFetchingNextPage ? (
          <ActivityIndicator color={t.brand} style={{ margin: space.lg }} />
        ) : undefined
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${LABEL[item.type]} ${Math.abs(item.points)} points on ${date(item.createdAt)}. Open receipt`}
          disabled={!item.slipNumber}
          onPress={() => router.push({ pathname: '/slip/[id]', params: { id: item.id } })}
        >
          <Card
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <View style={{ gap: 4 }}>
              <Pill text={LABEL[item.type]} tone={item.points < 0 ? 'warn' : 'ok'} />
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {date(item.createdAt)}
                {item.amountPaise ? ` · ${formatRupees(item.amountPaise)}` : ''}
              </Text>
            </View>
            <Text
              style={{ color: item.points < 0 ? t.warn : t.ok, fontSize: 20, fontWeight: '800' }}
            >
              {item.points > 0 ? '+' : ''}
              {formatPoints(item.points)}
            </Text>
          </Card>
        </Pressable>
      )}
    />
  );
}
