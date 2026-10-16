import { useColorScheme } from 'react-native';

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  brand: string;
  brandText: string;
  brandSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  bad: string;
  badSoft: string;
}

const light: Theme = {
  dark: false,
  bg: '#f6f7f9',
  surface: '#ffffff',
  surface2: '#f0f2f5',
  border: '#e3e6eb',
  text: '#14171f',
  muted: '#667085',
  brand: '#e8590c',
  brandText: '#ffffff',
  brandSoft: '#fff1e8',
  ok: '#067647',
  okSoft: '#e7f6ee',
  warn: '#b54708',
  bad: '#b42318',
  badSoft: '#fdecea',
};

const dark: Theme = {
  dark: true,
  bg: '#0c0f14',
  surface: '#151a22',
  surface2: '#1b212b',
  border: '#262e3a',
  text: '#eef1f6',
  muted: '#8d98aa',
  brand: '#ff7a2e',
  brandText: '#1a0d04',
  brandSoft: '#2b1b12',
  ok: '#4ade80',
  okSoft: '#12261b',
  warn: '#fbbf24',
  bad: '#f87171',
  badSoft: '#2d1616',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16 } as const;
/** Minimum comfortable touch target (WCAG / Material: 48dp). Pump staff often wear gloves. */
export const TOUCH = 52;
