import { LogoMark, Spinner } from '@financialos/ui';

/** Neutral screen shown while the session is (re)checked. Contains no data. */
export function NeutralCover({ label = 'Checking your session' }: { label?: string }) {
  return (
    <div className="fos-cover" role="status" aria-live="polite">
      <div className="fos-cover__inner">
        <LogoMark size={40} title="" />
        <span className="inline-flex items-center gap-2">
          <Spinner size={16} label="" />
          {label}
        </span>
      </div>
    </div>
  );
}
