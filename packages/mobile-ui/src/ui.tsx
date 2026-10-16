import { ApiError } from '@petropoints/mobile-core';
import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { TOUCH, radius, space, useTheme } from './theme';

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const first = Array.isArray(e.details)
      ? (e.details[0] as { message?: string } | undefined)
      : undefined;
    return first?.message ? `${e.message}: ${first.message}` : e.message;
  }
  if (e instanceof TypeError || (e instanceof Error && e.name === 'AbortError')) {
    return 'Can’t reach the server. Check your connection and try again.';
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

export function Screen({
  children,
  scroll = true,
  padded = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
}) {
  const t = useTheme();
  const body = padded ? { padding: space.lg, gap: space.lg } : undefined;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {scroll ? (
        <ScrollView contentContainerStyle={body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, body]}>{children}</View>
      )}
    </KeyboardAvoidingView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: space.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Heading({ children, size = 22 }: { children: ReactNode; size?: number }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={{ color: t.text, fontSize: size, fontWeight: '700' }}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted,
  style,
}: {
  children: ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.muted : t.text, fontSize: 15 }, style]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.brand : t.surface;
  const fg = variant === 'primary' ? t.brandText : variant === 'danger' ? t.bad : t.text;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        borderRadius: radius.md,
        backgroundColor: bg,
        borderWidth: variant === 'primary' ? 0 : 1,
        borderColor: t.border,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.lg,
        opacity: off ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: 16, fontWeight: '700' }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ color: t.text, fontWeight: '600', fontSize: 13 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        {...props}
        style={{
          minHeight: TOUCH,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: error ? t.bad : t.border,
          backgroundColor: t.surface,
          color: t.text,
          paddingHorizontal: space.md,
          fontSize: 16,
        }}
      />
      {error ? <Text style={{ color: t.bad, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  const t = useTheme();
  if (!error) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: t.badSoft, borderRadius: radius.md, padding: space.md }}
    >
      <Text style={{ color: t.bad, fontWeight: '600' }}>{errorText(error)}</Text>
    </View>
  );
}

export function Pill({
  text,
  tone = 'neutral',
}: {
  text: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'brand';
}) {
  const t = useTheme();
  const map = {
    neutral: [t.surface2, t.muted],
    ok: [t.okSoft, t.ok],
    warn: [t.surface2, t.warn],
    bad: [t.badSoft, t.bad],
    brand: [t.brandSoft, t.brand],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 3,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: t.bg,
        padding: space.xl,
      }}
    >
      {children}
    </View>
  );
}

export function Spinner() {
  const t = useTheme();
  return (
    <Centered>
      <ActivityIndicator size="large" color={t.brand} />
    </Centered>
  );
}
