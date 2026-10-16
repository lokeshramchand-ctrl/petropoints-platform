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

export default function Login() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading size={28}>Welcome back</Heading>
      <Body muted>Sign in to see your PetroPoints.</Body>
      <ErrorBanner error={error} />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        textContentType="username"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
      />
      <Button
        title="Sign in"
        onPress={submit}
        loading={busy}
        disabled={!email || password.length < 8}
      />
      <Link href="/register" style={{ textAlign: 'center', paddingVertical: 12 }}>
        <Body muted>New here? Create an account</Body>
      </Link>
    </Screen>
  );
}
