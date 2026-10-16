import type { TransactionView } from '@petropoints/contracts';
import { formatPoints, formatRupees } from '@petropoints/mobile-core';
import {
  Body,
  Button,
  Card,
  ErrorBanner,
  Field,
  Pill,
  Spinner,
  space,
  useSession,
  useTheme,
} from '@petropoints/mobile-ui';
import { can } from '@petropoints/rbac';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Modal, RefreshControl, Text, View } from 'react-native';
import { api } from '../../src/api';
import { usePos } from '../../src/pos-context';

const date = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

export default function Activity() {
  const t = useTheme();
  const { user } = useSession();
  const { terminal } = usePos();
  const qc = useQueryClient();
  const canReverse = !!user && can(user.role, 'points:reverse');

  const q = useInfiniteQuery({
    queryKey: ['txns'],
    queryFn: ({ pageParam }) => api.transactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [target, setTarget] = useState<TransactionView | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const reverse = useMutation({
    // one key per dialog open: tapping twice retries the same operation instead of reversing twice
    mutationFn: (key: string) => api.reverse(target!.id, reason.trim(), key),
    onSuccess: async () => {
      setTarget(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['txns'] });
    },
  });
  const [reverseKey, setReverseKey] = useState('');

  if (q.isLoading) return <Spinner />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const reversed = new Set(items.map((i) => i.reversalOf).filter(Boolean));

  const reprint = async (id: string) => {
    try {
      await terminal.reprint(await api.slip(id));
      setNote('Slip sent to printer.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not print');
    }
  };

  return (
    <>
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
        ListHeaderComponent={
          <View style={{ gap: space.sm }}>
            <ErrorBanner error={q.error} />
            {note && <Body muted>{note}</Body>}
          </View>
        }
        ListEmptyComponent={
          <Body muted style={{ textAlign: 'center', marginTop: 40 }}>
            No transactions yet.
          </Body>
        }
        ListFooterComponent={
          q.isFetchingNextPage ? (
            <ActivityIndicator color={t.brand} style={{ margin: space.lg }} />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Card style={{ gap: space.sm }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <View style={{ gap: 4 }}>
                <Pill
                  text={item.type.toLowerCase()}
                  tone={item.type === 'EARN' ? 'ok' : item.type === 'REVERSAL' ? 'bad' : 'warn'}
                />
                <Text style={{ color: t.muted, fontSize: 12 }}>
                  {date(item.createdAt)}
                  {item.amountPaise ? ` · ${formatRupees(item.amountPaise)}` : ''}
                </Text>
                {item.slipNumber && (
                  <Text style={{ color: t.muted, fontSize: 12, fontFamily: 'monospace' }}>
                    {item.slipNumber}
                  </Text>
                )}
              </View>
              <Text
                style={{ color: item.points < 0 ? t.warn : t.ok, fontSize: 20, fontWeight: '800' }}
              >
                {item.points > 0 ? '+' : ''}
                {formatPoints(item.points)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {item.slipNumber && (
                <View style={{ flex: 1 }}>
                  <Button
                    title="Reprint"
                    variant="secondary"
                    onPress={() => void reprint(item.id)}
                  />
                </View>
              )}
              {canReverse &&
                (item.type === 'EARN' || item.type === 'REDEEM') &&
                !reversed.has(item.id) && (
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Reverse"
                      variant="danger"
                      onPress={() => {
                        setReverseKey(Crypto.randomUUID());
                        reverse.reset();
                        setTarget(item);
                      }}
                    />
                  </View>
                )}
            </View>
          </Card>
        )}
      />

      <Modal
        visible={!!target}
        animationType="slide"
        transparent
        onRequestClose={() => setTarget(null)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View
            style={{
              backgroundColor: t.surface,
              padding: space.lg,
              gap: space.md,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
            }}
          >
            <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>
              Reverse {target?.slipNumber}
            </Text>
            <Body muted>
              This posts an equal and opposite entry for {target ? formatPoints(target.points) : ''}{' '}
              points. It can’t be undone.
            </Body>
            <ErrorBanner error={reverse.error} />
            <Field
              label="Reason (kept in the audit trail)"
              value={reason}
              onChangeText={setReason}
              maxLength={300}
            />
            <Button
              title="Reverse transaction"
              variant="danger"
              loading={reverse.isPending}
              disabled={reason.trim().length < 3}
              onPress={() => reverse.mutate(reverseKey)}
            />
            <Button title="Cancel" variant="secondary" onPress={() => setTarget(null)} />
          </View>
        </View>
      </Modal>
    </>
  );
}
