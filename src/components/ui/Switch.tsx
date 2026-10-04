/** iOS / macOS style on-off switch. */
export default function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`ios-switch ${className ?? ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ios-switch-knob" />
    </button>
  );
}
