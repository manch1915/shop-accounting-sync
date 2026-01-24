'use client';

import type { LiveEvent } from '@sas/shared';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

type Listener = (event: LiveEvent) => void;
type State = 'connecting' | 'open' | 'retrying';

interface LiveContext {
  state: State;
  subscribe(listener: Listener): () => void;
}

const Context = createContext<LiveContext | null>(null);

/** One EventSource for the whole dashboard; pages subscribe to what they need. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [state, setState] = useState<State>('connecting');

  useEffect(() => {
    const source = new EventSource('/api/events', { withCredentials: true });
    const forward = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as LiveEvent;
      for (const listener of listeners.current) listener(event);
    };
    source.onopen = () => setState('open');
    // the browser reconnects on its own; we only reflect it in the header
    source.onerror = () => setState('retrying');
    source.addEventListener('operation', forward);
    source.addEventListener('conflict', forward);
    source.addEventListener('connection', forward);
    return () => source.close();
  }, []);

  const value: LiveContext = {
    state,
    subscribe(listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLive(listener?: Listener): State {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('useLive outside LiveProvider');
  const latest = useRef(listener);
  latest.current = listener;
  const { subscribe } = ctx;
  useEffect(() => subscribe((event) => latest.current?.(event)), [subscribe]);
  return ctx.state;
}
