import { useCallback, useEffect, useRef, useState } from 'react';

const RESET_MS = 2500;

export function useCopied() {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string) => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setCopiedText(null);
      return;
    }
    setCopiedText(text);
    timer.current = setTimeout(() => setCopiedText(null), RESET_MS);
  }, []);

  return { copiedText, copy };
}
