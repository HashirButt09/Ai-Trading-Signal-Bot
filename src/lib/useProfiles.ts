import { useEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from '../engine/types';
import { MAIN, profileList, type ProfileInfo } from '../engine/profiles';
import { ProfileFeed, viewOf } from './profileFeed';
import type { Scanner } from './scanner';

const K_VIEW = 'st.view.v1';
const readView = () => {
  try {
    return localStorage.getItem(K_VIEW) || MAIN;
  } catch {
    return MAIN;
  }
};

/**
 * The timeframe bots the app can show, the one you picked (remembered on this device), and a
 * Scanner-shaped view of it. The main bot is the scanner itself; extra bots are read from the server.
 */
export function useProfiles(scanner: Scanner, settings: Settings) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const bots: ProfileInfo[] = profileList(settings);
  const extraIds = bots.filter((b) => b.id !== MAIN).map((b) => b.id);
  const feeds = useRef(new Map<string, ProfileFeed>());
  const [, setTick] = useState(0);

  const key = extraIds.join(',');
  const views = useMemo(() => {
    const out = new Map<string, Scanner>();
    for (const id of extraIds) {
      let f = feeds.current.get(id);
      if (!f) {
        f = new ProfileFeed(id, () => settingsRef.current);
        feeds.current.set(id, f);
      }
      out.set(id, viewOf(scanner, f));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scanner]);

  useEffect(() => {
    if (!scanner.remote) return;
    const offs: (() => void)[] = [];
    for (const id of extraIds) {
      const f = feeds.current.get(id);
      if (!f) continue;
      offs.push(f.subscribe(() => setTick((n) => n + 1)));
      f.start();
    }
    return () => {
      offs.forEach((o) => o());
      for (const id of extraIds) feeds.current.get(id)?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scanner.remote]);

  const [want, setWant] = useState(readView);
  const viewId = want !== MAIN && scanner.remote && views.has(want) ? want : MAIN;
  const setView = (id: string) => {
    setWant(id);
    try {
      localStorage.setItem(K_VIEW, id);
    } catch {
      /* not remembered, still works */
    }
  };
  const view = viewId === MAIN ? scanner : views.get(viewId)!;
  const feedOf = (id: string) => feeds.current.get(id) ?? null;
  return { bots: scanner.remote ? bots : bots.slice(0, 1), viewId, view, setView, views, feedOf };
}
