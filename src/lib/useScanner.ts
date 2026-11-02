import { useEffect, useRef, useState } from 'react';
import { Scanner } from './scanner';
import type { Settings } from '../engine/types';

/** Creates the scanner and restarts it only when data-affecting settings change. */
export function useScanner(settings: Settings) {
  const ref = useRef<Scanner | null>(null);
  if (!ref.current) ref.current = new Scanner(settings);
  const scanner = ref.current;
  const [, setTick] = useState(0);

  useEffect(() => {
    const off = scanner.subscribe(() => setTick((n) => n + 1));
    return () => {
      off();
    };
  }, [scanner]);

  const dataKey = `${settings.ltf}|${settings.htf}|${settings.watchlist.join(',')}`;
  useEffect(() => {
    scanner.settings = settings;
    scanner.stop();
    scanner.ltf.clear();
    scanner.htf.clear();
    scanner.forming.clear();
    scanner.state.clear();
    void scanner.start();
    return () => scanner.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, scanner]);

  useEffect(() => {
    scanner.updateSettings(settings);
  }, [settings, scanner]);

  useEffect(() => {
    void scanner.connectServer();
    const onVis = () => {
      if (document.visibilityState === 'visible' && scanner.remote) void scanner.poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [scanner]);

  return scanner;
}
