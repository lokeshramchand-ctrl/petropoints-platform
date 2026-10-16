import { Body, Button, Card, Heading, Screen, useSession } from '@petropoints/mobile-ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../src/api';

export default function Profile() {
  const { user, logout } = useSession();
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: api.wallet });
  const [busy, setBusy] = useState(false);

  return (
    <Screen>
      <Card style={{ gap: 6 }}>
        <Heading>{user?.name}</Heading>
        <Body muted>{wallet.data?.mobile ?? ''}</Body>
      </Card>
      <Button
        title="Sign out"
        variant="danger"
        loading={busy}
        onPress={() => {
          setBusy(true);
          void logout();
        }}
      />
    </Screen>
  );
}
