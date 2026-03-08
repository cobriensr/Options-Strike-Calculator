export interface Theme {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly inputBg: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly borderHeavy: string;
  readonly text: string;
  readonly textSecondary: string;
  readonly textTertiary: string;
  readonly textMuted: string;
  readonly textPlaceholder: string;
  readonly accent: string;
  readonly accentBg: string;
  readonly green: string;
  readonly red: string;
  readonly badgeColor: string;
  readonly tooltipBg: string;
  readonly tooltipText: string;
  readonly tooltipCodeBg: string;
  readonly tooltipCodeText: string;
  readonly focusRing: string;
  readonly tableRowAlt: string;
  readonly tableHeader: string;
  readonly chipBg: string;
  readonly chipActiveBg: string;
  readonly chipBorder: string;
  readonly chipActiveBorder: string;
  readonly chipText: string;
  readonly chipActiveText: string;
  readonly chevronColor: string;
  readonly dateScheme: 'light' | 'dark';
}

export const lightTheme: Theme = {
  bg: '#F4F1EB',
  surface: '#FFFFFF',
  surfaceAlt: '#EDEAE3',
  inputBg: '#FAF9F6',
  border: '#DDD8CE',
  borderStrong: '#C8C3B8',
  borderHeavy: '#2C2A25',
  text: '#1C1A15',
  textSecondary: '#4A4740',
  textTertiary: '#5C5950',
  textMuted: '#7A756B',
  textPlaceholder: '#9B9689',
  accent: '#1D4ED8',
  accentBg: '#EFF6FF',
  green: '#15803D',
  red: '#B91C1C',
  badgeColor: '#15803D',
  tooltipBg: '#1C1A15',
  tooltipText: '#F4F1EB',
  tooltipCodeBg: '#f0f0f0',
  tooltipCodeText: '#1C1A15',
  focusRing: '#2563EB',
  tableRowAlt: '#FAF9F6',
  tableHeader: '#F4F1EB',
  chipBg: '#FFFFFF',
  chipActiveBg: '#EFF6FF',
  chipBorder: '#C8C3B8',
  chipActiveBorder: '#1D4ED8',
  chipText: '#4A4740',
  chipActiveText: '#1D4ED8',
  chevronColor: '#5C5950',
  dateScheme: 'light',
};

export const darkTheme: Theme = {
  bg: '#121212',
  surface: '#1E1E1E',
  surfaceAlt: '#2A2A2A',
  inputBg: '#252525',
  border: '#333333',
  borderStrong: '#444444',
  borderHeavy: '#E0DDD6',
  text: '#ECECEC',
  textSecondary: '#C0C0C0',
  textTertiary: '#A0A0A0',
  textMuted: '#808080',
  textPlaceholder: '#606060',
  accent: '#6B9CFF',
  accentBg: '#1A2744',
  green: '#4ADE80',
  red: '#F87171',
  badgeColor: '#4ADE80',
  tooltipBg: '#ECECEC',
  tooltipText: '#1E1E1E',
  tooltipCodeBg: '#333333',
  tooltipCodeText: '#e0e0e0',
  focusRing: '#6B9CFF',
  tableRowAlt: '#252525',
  tableHeader: '#2A2A2A',
  chipBg: '#252525',
  chipActiveBg: '#1A2744',
  chipBorder: '#444444',
  chipActiveBorder: '#6B9CFF',
  chipText: '#C0C0C0',
  chipActiveText: '#6B9CFF',
  chevronColor: '#A0A0A0',
  dateScheme: 'dark',
};
