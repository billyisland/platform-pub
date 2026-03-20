'use client'

interface AllowanceExhaustedModalProps {
  onClose: () => void
}

export function AllowanceExhaustedModal({ onClose }: AllowanceExhaustedModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface mx-4 max-w-sm w-full p-8 shadow-xl" onClick={e => e.stopPropagation()}>
        <p className="font-serif text-lg text-content-primary leading-relaxed mb-6">
          In real life this is when we would ask for your payment details, but this is just a game so you can keep spending imaginary money.
        </p>
        <button onClick={onClose} className="btn w-full py-2.5 text-ui-sm">
          OK
        </button>
      </div>
    </div>
  )
}
