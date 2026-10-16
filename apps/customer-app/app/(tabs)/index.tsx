import { formatPoints } from '@petropoints/mobile-core';
import {
  Body,
  Card,
  ErrorBanner,
  Heading,
  Screen,
  Spinner,
  space,
  useTheme,
} from '@petropoints/mobile-ui';
import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { api } from '../../src/api';

export default function Home() {
  const t = useTheme();
  const q = useQuery({ queryKey: ['wallet'], queryFn: api.wallet });

  if (q.isLoading) return <Spinner />;
  const w = q.data;

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
      {w && (
        <>
          <Card style={{ backgroundColor: t.brand, borderWidth: 0 }}>
            <Text style={{ color: t.brandText, opacity: 0.85, fontWeight: '600' }}>
              Hi {w.name.split(' ')[0]}, you have
            </Text>
            <Text
              accessibilityLabel={`${w.balance} points`}
              style={{
                color: t.brandText,
                fontSize: 52,
                fontWeight: '800',
                letterSpacing: -1,
                fontVariant: ['tabular-nums'],
              }}
            >
              {formatPoints(w.balance)}
            </Text>
            <Text style={{ color: t.brandText, opacity: 0.85 }}>PetroPoints</Text>
          </Card>

          <Card style={{ alignItems: 'center', gap: space.md }}>
            <Heading size={17}>Show this at the pump</Heading>
            <View
              accessible
              accessibilityLabel={`QR code for mobile number ${w.mobile}`}
              style={{ padding: space.md, backgroundColor: '#fff', borderRadius: 12 }}
            >
              <QRCode value={w.mobile} size={176} />
            </View>
            <Text
              style={{ color: t.text, fontSize: 20, fontWeight: '700', letterSpacing: 1 }}
              selectable
            >
              {w.mobile.replace('+91', '+91 ')}
            </Text>
            <Body muted style={{ textAlign: 'center' }}>
              The cashier scans this, or just tell them your number, to add points to your account.
            </Body>
          </Card>
        </>
      )}
    </ScrollView>
  );
}
