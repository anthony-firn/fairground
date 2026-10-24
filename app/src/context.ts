import { createContext, useContext } from 'react';
import type { Account } from './lib/account.ts';

export interface AppState {
  account: Account;
  navigate(path: string): void;
  toast(message: string): void;
  /** Bumped whenever the feed recipe or model changes, so the feed re-ranks. */
  recipeVersion: number;
  bumpRecipe(): void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp outside the app');
  return state;
}
