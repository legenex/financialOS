import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cx } from '../lib/cx';

export interface CodeBlockProps {
  code: string;
  /** Short label such as "Run on the host". */
  label?: string;
  className?: string;
  /** Hide the copy button (e.g. secrets that must never be copied to the clipboard). */
  copyable?: boolean;
  wrap?: boolean;
}

/** Monospace block for owner activation steps and one-time values, with a copy button. */
export function CodeBlock({ code, label, className, copyable = true, wrap = false }: CodeBlockProps) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 2500);
  };

  return (
    <figure className={cx('fos-code', wrap && 'fos-code--wrap', className)}>
      {(label || copyable) && (
        <figcaption className="fos-code__bar">
          <span className="fos-code__label">{label}</span>
          {copyable && (
            <button type="button" className="fos-code__copy" onClick={copy}>
              {copied === 'done' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              <span>{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</span>
            </button>
          )}
        </figcaption>
      )}
      <pre className="fos-code__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
      <span className="fos-sr-only" role="status" aria-live="polite">
        {copied === 'done' ? 'Copied to clipboard' : copied === 'failed' ? 'Could not copy to the clipboard' : ''}
      </span>
    </figure>
  );
}
