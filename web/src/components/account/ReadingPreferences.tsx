'use client'

import { useEffect, useState } from 'react'
import { readingPreferences } from '../../lib/api'

export function ReadingPreferences() {
  const [alwaysOpenAtTop, setAlwaysOpenAtTop] = useState<boolean | null>(null)

  useEffect(() => {
    readingPreferences.get()
      .then(res => setAlwaysOpenAtTop(res.alwaysOpenAtTop))
      .catch(() => setAlwaysOpenAtTop(false))
  }, [])

  async function set(value: boolean) {
    if (alwaysOpenAtTop === value) return
    const previous = alwaysOpenAtTop
    setAlwaysOpenAtTop(value)
    try {
      await readingPreferences.update(value)
    } catch {
      setAlwaysOpenAtTop(previous)
    }
  }

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Reading preferences</p>
      <div className="bg-white divide-y divide-grey-200/50">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="pr-6">
            <p className="text-ui-sm text-black">Always open articles at the top</p>
            <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
              By default, articles you've started reading reopen where you left off. Turn this on to always start from the beginning.
            </p>
          </div>
          <div className="flex shrink-0">
            <button
              onClick={() => set(true)}
              className={`label-ui toggle-chip ${
                alwaysOpenAtTop === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={alwaysOpenAtTop === null}
            >
              On
            </button>
            <button
              onClick={() => set(false)}
              className={`label-ui toggle-chip ${
                alwaysOpenAtTop === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={alwaysOpenAtTop === null}
            >
              Off
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
