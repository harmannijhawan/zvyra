/** Small inline icons (no icon dependency). All decorative: aria-hidden. */
type P = { size?: number; className?: string }

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  className,
  'aria-hidden': true as const,
  focusable: false as const
})

export const WindowsIcon = ({ size = 18, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="currentColor">
    <path d="M3 5.3 10.4 4.3v7.1H3zM11.4 4.1 21 2.8v8.6h-9.6zM3 12.5h7.4v7.2L3 18.7zM11.4 12.5H21v8.7l-9.6-1.3z" />
  </svg>
)

export const AppleIcon = ({ size = 18, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="currentColor">
    <path d="M16.4 12.6c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.3.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.1zM13.9 5.2c.7-.9 1.2-2 1-3.2-1 .1-2.2.7-3 1.6-.6.7-1.2 1.9-1 3.1 1.2.1 2.3-.6 3-1.5z" />
  </svg>
)

export const PhoneIcon = ({ size = 16, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="6.5" y="2.5" width="11" height="19" rx="3" />
    <path d="M10.5 18.5h3" />
  </svg>
)

export const ArrowDownIcon = ({ size = 16, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v15M6 13l6 6 6-6" />
  </svg>
)

export const CheckIcon = ({ size = 14, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
)

export const MicIcon = ({ size = 14, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </svg>
)

export const SparkIcon = ({ size = 14, className }: P) => (
  <svg viewBox="0 0 24 24" {...base(size, className)} fill="currentColor">
    <path d="M12 2.5 13.9 9 20.5 11 13.9 13 12 19.5 10.1 13 3.5 11 10.1 9z" />
  </svg>
)
