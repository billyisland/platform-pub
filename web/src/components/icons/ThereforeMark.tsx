interface ThereforeMarkProps {
  size?: number          // display width in px (height scales proportionally)
  weight?: 'heavy' | 'light'
  className?: string     // for colour via Tailwind (e.g. text-crimson, text-grey-400)
}

export function ThereforeMark({
  size = 22,
  weight = 'heavy',
  className = '',
}: ThereforeMarkProps) {
  const r = weight === 'heavy' ? 4.0 : 2.8
  const h = Math.round(size * (22 / 26))

  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 26 22"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <circle cx="13" cy="4.5" r={r} />
      <circle cx="5.2" cy="17.5" r={r} />
      <circle cx="20.8" cy="17.5" r={r} />
    </svg>
  )
}
