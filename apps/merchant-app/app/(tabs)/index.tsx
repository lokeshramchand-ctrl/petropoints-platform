import { FUEL_TYPES, pointsForSpend, type SlipView } from '@petropoints/contracts';
import {
  formatPoints,
  formatRupees,
  normaliseMobile,
  parseRupeesToPaise,
  slipLines,
  type SubmitOutcome,
} from '@petropoints/mobile-core';
import {
  Body,
  Button,
  Card,
  ErrorBanner,
  Field,
  Heading,
  Pill,
  Screen,
  TOUCH,
  errorText,
  radius,
  space,
  useSession,
  useTheme,
} from '@petropoints/mobile-ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { api, type CustomerLookup } from '../../src/api';
import { usePos } from '../../src/pos-context';

type Mode = 'earn' | 'redeem';

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: active ? t.brand : t.border,
        backgroundColor: active ? t.brandSoft : t.surface,
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: active ? t.brand : t.text, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

export default function Sale() {
  const t = useTheme();
  const { user } = useSession();
  const { terminal, refresh } = usePos();

  const [mode, setMode] = useState<Mode>('earn');
  const [mobileText, setMobileText] = useState('');
  const [customer, setCustomer] = useState<CustomerLookup | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [pointsText, setPointsText] = useState('');
  const [fuel, setFuel] = useState<(typeof FUEL_TYPES)[number]>('PETROL');
  const [pickedOutlet, setPickedOutlet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);

  // Cashiers are pinned to their outlet; managers/owners choose one.
  const pinnedOutlet = user?.role === 'CASHIER' ? user.outletId : null;
  const outlets = useQuery({
    queryKey: ['outlets', user?.merchantId],
    queryFn: () => api.outlets(user!.merchantId!),
    enabled: !pinnedOutlet && !!user?.merchantId,
  });
  const outletId =
    pinnedOutlet ?? pickedOutlet ?? (outlets.data?.length === 1 ? outlets.data[0]!.id : null);

  const mobile = normaliseMobile(mobileText);
  const paise = parseRupeesToPaise(amountText);
  const earnPoints = paise ? pointsForSpend(paise) : 0;
  const redeemPoints = /^\d{1,7}$/.test(pointsText) ? Number(pointsText) : 0;
  const ready = !!mobile && !!outletId && (mode === 'earn' ? earnPoints >= 1 : redeemPoints >= 1);

  const reset = () => {
    setOutcome(null);
    setError(null);
    setCustomer(null);
    setLookupNote(null);
    setMobileText('');
    setAmountText('');
    setPointsText('');
  };

  const lookup = async () => {
    if (!mobile) return;
    setError(null);
    setLookupNote(null);
    try {
      setCustomer(await api.lookup(mobile));
    } catch (e) {
      setCustomer(null);
      // Offline is not an error at the pump: the sale can still be taken and synced later.
      if (e instanceof TypeError || (e instanceof Error && e.name === 'AbortError')) {
        setLookupNote(
          'Offline: can’t check this customer. You can still record the sale; it will sync later.',
        );
      } else setError(e);
    }
  };

  const submit = async () => {
    if (!ready || !mobile || !outletId) return;
    setBusy(true);
    setError(null);
    try {
      const out =
        mode === 'earn'
          ? await terminal.submit('earn', {
              customerMobile: mobile,
              outletId,
              amountPaise: paise!,
              fuelType: fuel,
            })
          : await terminal.submit('redeem', {
              customerMobile: mobile,
              outletId,
              points: redeemPoints,
            });
      setOutcome(out);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    const who = customer?.name ?? mobile ?? 'customer';
    const msg =
      mode === 'earn'
        ? `Award ${formatPoints(earnPoints)} points to ${who} for ${formatRupees(paise ?? 0)}?`
        : `Redeem ${formatPoints(redeemPoints)} points from ${who}?`;
    Alert.alert(mode === 'earn' ? 'Confirm sale' : 'Confirm redemption', msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => void submit() },
    ]);
  };

  /* ---------- result view ---------- */
  if (outcome) {
    return (
      <Screen>
        {outcome.status === 'done' && (
          <>
            <Card style={{ backgroundColor: t.okSoft, gap: 4 }}>
              <Pill text="Done" tone="ok" />
              <Heading size={30}>
                {outcome.result.points > 0 ? '+' : ''}
                {formatPoints(outcome.result.points)} pts
              </Heading>
              <Body>New balance {formatPoints(outcome.result.balanceAfter)} pts</Body>
              {outcome.syncedEarlier > 0 && (
                <Body muted>Also synced {outcome.syncedEarlier} earlier offline sale(s).</Body>
              )}
            </Card>
            <PrintStatus outcome={outcome} onReprint={(s) => terminal.reprint(s)} />
            {outcome.result.slip && <SlipPreview slip={outcome.result.slip} />}
          </>
        )}
        {outcome.status === 'queued' && (
          <Card style={{ backgroundColor: t.surface2, gap: 6 }}>
            <Pill text="Saved offline" tone="warn" />
            <Heading size={20}>No connection. Sale stored safely.</Heading>
            <Body muted>
              It will be sent automatically when the network returns, with no risk of
              double-awarding. No slip can be printed until then.
            </Body>
          </Card>
        )}
        {outcome.status === 'rejected' && (
          <Card style={{ backgroundColor: t.badSoft, gap: 6 }}>
            <Pill text="Not applied" tone="bad" />
            <Heading size={20}>{outcome.message}</Heading>
            <Body muted>Nothing was changed on the customer’s account.</Body>
          </Card>
        )}
        <Button title="New sale" onPress={reset} />
      </Screen>
    );
  }

  /* ---------- entry view ---------- */
  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Chip label="Earn points" active={mode === 'earn'} onPress={() => setMode('earn')} />
        <Chip label="Redeem" active={mode === 'redeem'} onPress={() => setMode('redeem')} />
      </View>

      <ErrorBanner error={error} />

      {!pinnedOutlet && (outlets.data?.length ?? 0) > 1 && (
        <View style={{ gap: space.xs }}>
          <Body muted>Outlet</Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {outlets.data!.map((o) => (
              <Chip
                key={o.id}
                label={o.code}
                active={outletId === o.id}
                onPress={() => setPickedOutlet(o.id)}
              />
            ))}
          </View>
        </View>
      )}
      {outlets.error ? <ErrorBanner error={outlets.error} /> : null}

      <Field
        label="Customer mobile"
        value={mobileText}
        onChangeText={(v) => {
          setMobileText(v);
          setCustomer(null);
          setLookupNote(null);
        }}
        keyboardType="phone-pad"
        placeholder="98765 43210"
        error={mobileText && !mobile ? 'Enter a valid 10-digit mobile number' : undefined}
        onBlur={() => void lookup()}
      />
      {customer && (
        <Card
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <View>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{customer.name}</Text>
            <Body muted>{customer.mobileMasked}</Body>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Body muted>Balance</Body>
            <Text style={{ color: t.brand, fontWeight: '800', fontSize: 22 }}>
              {formatPoints(customer.balance)}
            </Text>
          </View>
        </Card>
      )}
      {lookupNote && <Body muted>{lookupNote}</Body>}

      {mode === 'earn' ? (
        <>
          <Field
            label="Sale amount (₹)"
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder="2500"
            error={amountText && !paise ? 'Enter an amount like 2500 or 2500.50' : undefined}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {FUEL_TYPES.map((f) => (
              <Chip
                key={f}
                label={f.replace('_', ' ').toLowerCase()}
                active={fuel === f}
                onPress={() => setFuel(f)}
              />
            ))}
          </View>
          <Card style={{ alignItems: 'center' }}>
            <Body muted>Customer earns</Body>
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: earnPoints ? t.ok : t.muted, fontSize: 40, fontWeight: '800' }}
            >
              {formatPoints(earnPoints)} pts
            </Text>
            {paise && earnPoints < 1 ? <Body muted>Below the ₹100 minimum for a point</Body> : null}
          </Card>
        </>
      ) : (
        <>
          <Field
            label="Points to redeem"
            value={pointsText}
            onChangeText={setPointsText}
            keyboardType="number-pad"
            placeholder="100"
          />
          {customer && redeemPoints > customer.balance ? (
            <ErrorBanner
              error={new Error(`Customer only has ${formatPoints(customer.balance)} points`)}
            />
          ) : null}
        </>
      )}

      <View style={{ minHeight: TOUCH }}>
        <Button
          title={mode === 'earn' ? 'Award points & print slip' : 'Redeem & print slip'}
          onPress={confirm}
          loading={busy}
          disabled={!ready || (mode === 'redeem' && !!customer && redeemPoints > customer.balance)}
        />
      </View>
    </Screen>
  );
}

function PrintStatus({
  outcome,
  onReprint,
}: {
  outcome: Extract<SubmitOutcome, { status: 'done' }>;
  onReprint: (s: SlipView) => Promise<void>;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const slip = outcome.result.slip;
  if (outcome.print === 'printed') return <Pill text="Slip printed" tone="ok" />;
  return (
    <Card style={{ gap: space.sm }}>
      <Pill
        text={outcome.print === 'no-printer' ? 'No printer connected' : 'Printing failed'}
        tone="warn"
      />
      {typeof outcome.print === 'object' && <Body muted>{outcome.print.failed}</Body>}
      {msg && <Body muted>{msg}</Body>}
      {slip && (
        <Button
          title="Retry print"
          variant="secondary"
          onPress={() =>
            onReprint(slip).then(
              () => setMsg('Printed.'),
              (e) => setMsg(errorText(e)),
            )
          }
        />
      )}
    </Card>
  );
}

function SlipPreview({ slip }: { slip: SlipView }) {
  const t = useTheme();
  return (
    <Card>
      <Text style={{ fontFamily: 'monospace', color: t.text, fontSize: 12.5, lineHeight: 18 }}>
        {slipLines(slip).join('\n')}
      </Text>
    </Card>
  );
}
