import { useRef, useState } from 'react';
import { readHomeSort, writeHomeSort, type HomeSort } from './home-sorting';

export function useHomeSort(userId: string | undefined): [HomeSort, (mode: HomeSort) => void] {
  const preferences = useRef(new Map<string, HomeSort>());
  const [, render] = useState(0);
  if (userId && !preferences.current.has(userId)) preferences.current.set(userId, readHomeSort(userId));
  const mode = userId ? preferences.current.get(userId)! : 'name';
  return [mode, (next) => {
    if (!userId) return;
    preferences.current.set(userId, next);
    writeHomeSort(userId, next);
    render((value) => value + 1);
  }];
}
