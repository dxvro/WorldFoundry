import type { GameDefinition, GameId } from '@worldfoundry/backend/contract';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { gamesApi } from '../lib/endpoints';
import { useQuery } from '../lib/useQuery';
import { GAME_LOOK } from './look';

interface GamesValue {
  // null while loading; empty when the list could not be loaded
  games: GameDefinition[] | null;
  // why the list could not be loaded; null while loading and after a success
  error: Error | null;
  reload: () => void;
  find: (id: GameId) => GameDefinition | undefined;
  // the name of a game, also before the list has arrived
  nameOf: (id: GameId) => string;
}

const EMPTY: GamesValue = { games: null, error: null, reload: () => undefined, find: () => undefined, nameOf: (id) => GAME_LOOK[id].shortName };
const GamesContext = createContext<GamesValue>(EMPTY);

// The facts of the games (names, disclaimers, ports, mod sources) come from the backend, which is their only source.
export function GamesProvider({ children }: { children: ReactNode }): ReactNode {
  const query = useQuery((signal) => gamesApi.list(signal), []);
  const value = useMemo<GamesValue>(() => {
    const games = query.data?.games ?? (query.error === null ? null : []);
    const find = (id: GameId): GameDefinition | undefined => games?.find((game) => game.id === id);
    return { games, error: query.error, reload: query.reload, find, nameOf: (id) => find(id)?.name ?? GAME_LOOK[id].shortName };
  }, [query.data, query.error, query.reload]);
  return <GamesContext.Provider value={value}>{children}</GamesContext.Provider>;
}

export const useGames = (): GamesValue => useContext(GamesContext);
