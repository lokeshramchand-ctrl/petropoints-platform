import type { SlipView } from '@petropoints/contracts';
import { slipLines } from '@petropoints/mobile-core';
import {
  Body,
  Button,
  Card,
  Heading,
  Pill,
  Screen,
  errorText,
  useSession,
  useTheme,
} from '@petropoints/mobile-ui';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { deviceSerial } from '../../src/device';
import { usePos } from '../../src/pos-context';
import { createPrinter } from '../../src/printer';

const TEST_SLIP: SlipView = {
  slipNumber: 'TEST-00000000-000000',
  transactionId: '00000000-0000-4000-8000-000000000000',
  type: 'EARN',
  merchantName: 'PetroPoints',
  outletName: 'Printer self-test',
  customerName: 'Test Customer',
  customerMobileMasked: '+91*******000',
  points: 10,
  balanceAfter: 10,
  amountPaise: 100_000,
  createdAt: new Date().toISOString(),
  signature: 'test',
};

export default function Device() {
  const t = useTheme();
  const { user, logout } = useSession();
  const { terminal, pending, syncNow } = usePos();
  const [serial, setSerial] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sync' | 'print' | 'out' | null>(null);

  useEffect(() => setSerial(deviceSerial()), []);

  const run = async (kind: 'sync' | 'print', fn: () => Promise<unknown>, ok: string) => {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Card style={{ gap: 6 }}>
        <Heading size={18}>{user?.name}</Heading>
        <Pill text={(user?.role ?? '').replaceAll('_', ' ').toLowerCase()} tone="brand" />
      </Card>

      <Card style={{ gap: 6 }}>
        <Body muted>Device ID: give this to your administrator to register this handset</Body>
        <Text selectable style={{ color: t.text, fontFamily: 'monospace', fontSize: 16 }}>
          {serial ?? 'Unavailable on this device'}
        </Text>
      </Card>

      <Card style={{ gap: 8 }}>
        <Heading size={16}>Offline sales</Heading>
        <Body muted>
          {pending === 0 ? 'All sales are synced.' : `${pending} sale(s) waiting for a connection.`}
        </Body>
        <Button
          title="Sync now"
          variant="secondary"
          loading={busy === 'sync'}
          onPress={() => void run('sync', syncNow, 'Sync finished.')}
        />
      </Card>

      <Card style={{ gap: 8 }}>
        <Heading size={16}>Printer</Heading>
        <Body muted>Adapter: {safePrinterName()}</Body>
        <Button
          title="Print test slip"
          variant="secondary"
          loading={busy === 'print'}
          onPress={() => void run('print', () => terminal.reprint(TEST_SLIP), 'Test slip sent.')}
        />
        <Text style={{ color: t.muted, fontFamily: 'monospace', fontSize: 11, lineHeight: 15 }}>
          {slipLines(TEST_SLIP).join('\n')}
        </Text>
      </Card>

      {msg && <Body muted>{msg}</Body>}

      <Button
        title="Sign out"
        variant="danger"
        loading={busy === 'out'}
        onPress={() => {
          if (pending > 0) {
            setMsg(
              `${pending} offline sale(s) haven’t synced yet. Sync before signing out so none are lost.`,
            );
            return;
          }
          setBusy('out');
          void logout();
        }}
      />
    </Screen>
  );
}

function safePrinterName(): string {
  try {
    return createPrinter().name;
  } catch (e) {
    return errorText(e);
  }
}
