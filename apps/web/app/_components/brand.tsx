export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="VoxIA Control">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <path d="M16 2.5 28 7v8.2c0 7.3-4.9 12.2-12 14.3-7.1-2.1-12-7-12-14.3V7l12-4.5Z" />
          <path d="m10.3 16 3.7 3.7 7.8-8" />
        </svg>
      </span>
      <span>
        <strong>VoxIA</strong>
        {!compact ? <small>Control</small> : null}
      </span>
    </div>
  );
}
