// Model choice (ADR 0017): every model whose provider has a key, grouped by provider.
import React from 'react';
import { PROVIDERS, type ModelInfo } from '@atlas/contracts';

const label = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id;

export function ModelSelect({ models, value, onChange, empty, testId, disabled }: { models: ModelInfo[]; value: string | null; onChange: (v: string | null) => void; empty: string; testId?: string; disabled?: boolean }) {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  // A saved choice whose provider lost its key stays visible, marked, instead of silently showing the default.
  const missing = value && !models.some((m) => m.ref === value);
  return (
    <select className="lv-native-select" data-testid={testId} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {missing && <option value={value!}>{value} (no key)</option>}
      {[...byProvider.entries()].sort(([a], [b]) => label(a).localeCompare(label(b))).map(([p, list]) => (
        <optgroup key={p} label={label(p)}>
          {list.map((m) => <option key={m.ref} value={m.ref}>{m.name}{m.reasoning ? ' · reasoning' : ''}{m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
