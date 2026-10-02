import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'warn' | 'good';
}): JSX.Element {
  return (
    <div className={`stat${tone && tone !== 'default' ? ` stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
}: {
  tone?: 'info' | 'warn' | 'error' | 'good';
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}): JSX.Element {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
      <div className="banner-actions">
        {action}
        {onDismiss && (
          <button type="button" className="ghost icon" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * Copy-to-clipboard text.
 *
 * Used for chrome:// instructions, which a page is not allowed to link to or navigate to,
 * so handing over the text is the only thing that actually helps.
 */
export function CopyBox({ value, label }: { value: string; label?: string }): JSX.Element {
  return (
    <div className="copybox">
      <code>{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
        }}
      >
        {label ?? 'Copy'}
      </button>
    </div>
  );
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" />
      {label && <span className="muted small">{label}</span>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

const ToastHostContext = createContext<HTMLElement | null>(null);

/**
 * A fixed layer for transient messages.
 *
 * Toasts float over the page instead of being inserted into it, so a connection hiccup
 * or a failed write never pushes the controls the user is reaching for out from under
 * their finger.
 */
export function ToastHost({ children }: { children: ReactNode }): JSX.Element {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <ToastHostContext.Provider value={node}>
      {children}
      <div ref={setNode} className="toasts" aria-live="polite" />
    </ToastHostContext.Provider>
  );
}

export function Toast({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  timeoutMs,
}: {
  tone?: 'info' | 'warn' | 'error' | 'good';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  /** Dismisses itself after this long. Needs `onDismiss`. */
  timeoutMs?: number;
}): JSX.Element | null {
  const host = useContext(ToastHostContext);
  // Held in a ref so a parent re-render does not restart the countdown.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (!timeoutMs) return undefined;
    const timer = setTimeout(() => dismiss.current?.(), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs]);

  if (!host) return null;
  return createPortal(
    <div className={`toast toast-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="toast-dot" aria-hidden="true" />
      <div className="toast-body">
        {title && <strong>{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {action && <div className="toast-actions">{action}</div>}
      {onDismiss && (
        <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>,
    host,
  );
}

/**
 * True once `active` has stayed true for `ms`.
 *
 * Used to keep momentary states off the screen: a link that drops and recovers within
 * a second is not worth a message.
 */
export function useHeld(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return undefined;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && held;
}
