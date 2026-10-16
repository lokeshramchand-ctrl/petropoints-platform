import { slipLines, slipQrPayload } from '@petropoints/mobile-core';
import { Body, Card, ErrorBanner, Pill, Screen, Spinner, useTheme } from '@petropoints/mobile-ui';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { api } from '../../src/api';

/** The same layout the thermal printer prints, so on-screen and paper never disagree. */
export default function SlipScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const slip = useQuery({ queryKey: ['slip', id], queryFn: () => api.slip(id) });
  const verified = useQuery({
    queryKey: ['slip-verify', id],
    queryFn: () => api.verify(slip.data!),
    enabled: !!slip.data,
  });

  if (slip.isLoading) return <Spinner />;
  return (
    <Screen>
      <ErrorBanner error={slip.error} />
      {slip.data && (
        <>
          <Card style={{ gap: 12 }}>
            <View>
              {verified.data ? (
                <Pill
                  text={verified.data.valid ? 'Verified by PetroPoints' : 'Could not verify'}
                  tone={verified.data.valid ? 'ok' : 'bad'}
                />
              ) : null}
            </View>
            <Text
              accessibilityLabel={slipLines(slip.data).join('. ')}
              style={{ fontFamily: 'monospace', color: t.text, fontSize: 12.5, lineHeight: 18 }}
            >
              {slipLines(slip.data).join('\n')}
            </Text>
            <View
              style={{
                alignItems: 'center',
                padding: 12,
                backgroundColor: '#fff',
                borderRadius: 12,
                alignSelf: 'center',
              }}
            >
              <QRCode value={slipQrPayload(slip.data)} size={140} />
            </View>
          </Card>
          <Body muted style={{ textAlign: 'center' }}>
            Keep this receipt for disputes. It can be verified by scanning the QR.
          </Body>
        </>
      )}
    </Screen>
  );
}
