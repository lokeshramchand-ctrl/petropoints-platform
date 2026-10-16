import { normaliseMobile } from '@petropoints/mobile-core';
import {
  Body,
  Button,
  ErrorBanner,
  Field,
  Heading,
  Screen,
  useSession,
} from '@petropoints/mobile-ui';
import { Link } from 'expo-router';
import { useState } from 'react';
import { api } from '../../src/api';

export default function Register() {
  const { login } = useSession();
  const [f, setF] = useState({ name: '', email: '', mobile: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const mobile = normaliseMobile(f.mobile);
  const mobileError =
    f.mobile && !mobile ? 'Enter a valid 10-digit Indian mobile number' : undefined;
  const valid =
    f.name.trim().length >= 2 && f.email.includes('@') && !!mobile && f.password.length >= 8;

  const submit = async () => {
    if (!mobile) return;
    setBusy(true);
    setError(null);
    try {
      await api.register({
        name: f.name.trim(),
        email: f.email.trim(),
        mobile,
        password: f.password,
      });
      await login(f.email.trim(), f.password);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading size={28}>Create your account</Heading>
      <Body muted>
        Your mobile number is how petrol bunks find your points, so use the one you’ll give at the
        pump.
      </Body>
      <ErrorBanner error={error} />
      <Field
        label="Full name"
        value={f.name}
        onChangeText={set('name')}
        autoComplete="name"
        textContentType="name"
      />
      <Field
        label="Email"
        value={f.email}
        onChangeText={set('email')}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
      />
      <Field
        label="Mobile number"
        value={f.mobile}
        onChangeText={set('mobile')}
        keyboardType="phone-pad"
        autoComplete="tel"
        error={mobileError}
        placeholder="98765 43210"
      />
      <Field
        label="Password"
        value={f.password}
        onChangeText={set('password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={f.password && f.password.length < 8 ? 'At least 8 characters' : undefined}
      />
      <Button title="Create account" onPress={submit} loading={busy} disabled={!valid} />
      <Link href="/login" style={{ textAlign: 'center', paddingVertical: 12 }}>
        <Body muted>Already have an account? Sign in</Body>
      </Link>
    </Screen>
  );
}
