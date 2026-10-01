import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
type Size = 'sm' | 'md' | 'lg' | 'xl';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-slate-400',
  secondary: 'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-slate-400',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-slate-400',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100',
};
const sizes: Record<Size, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-base',
  lg: 'min-h-12 px-5 text-base font-semibold',
  xl: 'min-h-16 px-6 text-lg font-bold tracking-wide',
};
const base = 'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed';

export function Button({ variant = 'primary', size = 'md', className, ...props }: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button type="button" className={cx(base, variants[variant], sizes[size], className)} {...props} />;
}

export function LinkButton({ variant = 'primary', size = 'md', className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={cx(base, variants[variant], sizes[size], className)} {...props} />;
}

export function Card({ className, children, ...rest }: ComponentProps<'section'>) {
  return (
    <section className={cx('rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5', className)} {...rest}>
      {children}
    </section>
  );
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-800 ring-slate-300',
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  warn: 'bg-amber-50 text-amber-900 ring-amber-300',
  bad: 'bg-red-50 text-red-800 ring-red-300',
  info: 'bg-sky-50 text-sky-900 ring-sky-300',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}

/** Stock status always shown as text (never color alone). */
export function StockBadge({ status }: { status: string }) {
  const map: Record<string, [Tone, string]> = {
    HEALTHY: ['good', 'Healthy'],
    LOW_STOCK: ['warn', 'Low stock'],
    CRITICAL: ['bad', 'Critical'],
    OUT_OF_STOCK: ['bad', 'Out of stock'],
  };
  const [tone, label] = map[status] ?? ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Stat({ label, value, sub, tone, href }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <>
      <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-bold tabular-nums', tone === 'bad' && 'text-red-700', tone === 'warn' && 'text-amber-700', tone === 'good' && 'text-emerald-700')}>{value}</div>
      {sub && <div className="mt-0.5 text-sm text-slate-500">{sub}</div>}
    </>
  );
  const cls = 'block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm';
  return href ? <Link href={href} className={cx(cls, 'hover:border-brand')}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="text-lg font-semibold text-slate-800">{title}</p>
      {children && <div className="mt-1 text-slate-600">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'bad', title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-xl p-4 ring-1 ring-inset', tones[tone])}>
      {title && <p className="font-bold">{title}</p>}
      {children && <div className={cx(title && 'mt-1', 'text-sm')}>{children}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-slate-800">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}

const inputCls = 'min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-slate-100';
export function Input({ className, ...p }: ComponentProps<'input'>) {
  return <input className={cx(inputCls, className)} {...p} />;
}
export function Select({ className, ...p }: ComponentProps<'select'>) {
  return <select className={cx(inputCls, 'pr-8', className)} {...p} />;
}
export function Textarea({ className, ...p }: ComponentProps<'textarea'>) {
  return <textarea className={cx(inputCls, 'min-h-20 py-2', className)} {...p} />;
}

/** Responsive table: scrolls inside its own box, never the page. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-2xl border border-slate-200 bg-white', className)}>
      <table className="w-full min-w-[36rem] text-left text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx('border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-600', className)}>{children}</th>;
}
export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx('border-b border-slate-100 px-3 py-2 align-top', className)}>
      {children}
    </td>
  );
}
