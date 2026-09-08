import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function LoadingField({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <span className="loading-field">
      {children}
      {loading && <LoaderCircle className="field-spinner spin" size={18} aria-hidden="true" />}
    </span>
  );
}
