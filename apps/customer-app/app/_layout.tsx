import { SessionProvider, Spinner, useSession, useTheme } from '@petropoints/mobile-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ApiError } from '@petropoints/mobile-core';
import { client } from '../src/api';

// module-level constant: a fresh array each render would re-run the session-restore effect
const ROLES = ['CUSTOMER'] as const;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

function Gate() {
  const { user, restoring } = useSession();
  const t = useTheme();
  const inAuth = useSegments()[0] === '(auth)';

  if (restoring) return <Spinner />;
  if (!user && !inAuth) return <Redirect href="/login" />;
  if (user && inAuth) return <Redirect href="/" />;

  return (
    <>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="slip/[id]" options={{ title: 'Receipt', presentation: 'modal' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={client} allowedRoles={ROLES} appName="customer">
        <Gate />
      </SessionProvider>
    </QueryClientProvider>
  );
}
