import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { AppController, type AppState } from '../app/AppController.js';

const ControllerContext = createContext<AppController | null>(null);

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const controller = useMemo(() => new AppController(), []);

  useEffect(() => {
    void controller.init();
    // Deliberately no teardown here. In development StrictMode mounts, unmounts and
    // remounts, and disconnecting in between would tear down a Bluetooth session the user
    // just started. The device is released on pagehide instead.
    return undefined;
  }, [controller]);

  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function useController(): AppController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error('useController must be used inside <AppProvider>.');
  return controller;
}

/**
 * Subscribes to the controller snapshot.
 *
 * `useSyncExternalStore` would be the idiomatic choice, but the controller already
 * guarantees a new object only when something changed, and a plain subscription keeps the
 * dependency list to zero.
 */
export function useAppState(): AppState {
  const controller = useController();
  const [state, setState] = useState<AppState>(() => controller.getSnapshot());

  useEffect(() => {
    setState(controller.getSnapshot());
    return controller.subscribe(() => setState(controller.getSnapshot()));
  }, [controller]);

  return state;
}
