export const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '1d': 86_400_000
};

export const LTF_OPTIONS = ['1m', '3m', '5m', '15m', '30m'];
export const HTF_OPTIONS = ['15m', '30m', '1h', '4h', '1d'];

/** sensible default context timeframe for an execution timeframe */
export const DEFAULT_HTF: Record<string, string> = {
  '1m': '15m',
  '3m': '15m',
  '5m': '1h',
  '15m': '4h',
  '30m': '4h'
};
