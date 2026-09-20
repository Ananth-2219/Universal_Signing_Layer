'use client';

import type { ReactNode } from 'react';
import { eth } from '../lib/format';

export function Panel({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
      {children}
    </section>
  );
}

export function Badge({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'warn' | 'err'; children: ReactNode }) {
  return <span className={`badge ${tone === 'info' ? '' : tone}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function TextInput(input: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
  width?: number;
}) {
  return (
    <input
      type="text"
      className="mono"
      style={input.width ? { width: input.width } : undefined}
      value={input.value}
      placeholder={input.placeholder}
      disabled={input.disabled}
      onChange={event => input.onChange(event.target.value)}
    />
  );
}

/** Spend against the fixed-window budget, straight from the contract's own numbers. */
export function BudgetBar({ spent, budget }: { spent: bigint; budget: bigint }) {
  const percent = budget > 0n ? Number((spent * 10_000n) / budget) / 100 : 0;
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className={`bar${percent >= 100 ? ' full' : ''}`} style={{ width: 120 }}>
        <span style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className="muted">{percent.toFixed(1)}%</span>
      <span className="mono">{eth(spent)} / {eth(budget)} ETH</span>
    </div>
  );
}
