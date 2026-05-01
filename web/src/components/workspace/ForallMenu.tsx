'use client'

import { useEffect, useRef, useState } from 'react'

const TOKENS = {
  buttonBg: '#1A1A18',
  buttonFg: '#F0EFEB',
  buttonRing: '#4A4A47',
  menuBg: '#FFFFFF',
  menuBorder: '#1A1A18',
  itemFg: '#1A1A18',
  itemHoverBg: '#F0EFEB',
  itemFocusBg: '#E6E5E0',
  itemMuted: '#8A8880',
}

export type ForallAction = 'new-feed' | 'new-note' | 'fork' | 'reset'

interface MenuItem {
  key: ForallAction
  label: string
}

interface ForallMenuProps {
  onAction: (key: ForallAction) => void
}

export function ForallMenu({ onAction }: ForallMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const items: MenuItem[] = [
    { key: 'new-feed', label: 'New feed' },
    { key: 'new-note', label: 'New note' },
    { key: 'fork', label: 'Fork feed by URL' },
    { key: 'reset', label: 'Reset workspace layout' },
  ]

  function selectItem(key: ForallAction) {
    setOpen(false)
    buttonRef.current?.focus()
    onAction(key)
  }

  useEffect(() => {
    if (!open) return
    setActiveIndex(0)
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t)) return
      if (buttonRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(items.length - 1)
    }
  }

  return (
    <div
      style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 50 }}
    >
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Workspace actions"
          onKeyDown={onMenuKey}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 64,
            minWidth: 240,
            background: TOKENS.menuBg,
            border: `1px solid ${TOKENS.menuBorder}`,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
          }}
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              role="menuitem"
              type="button"
              onClick={() => selectItem(item.key)}
              onMouseEnter={() => setActiveIndex(i)}
              className="font-sans text-[14px] block w-full text-left"
              style={{
                color: TOKENS.itemFg,
                padding: '10px 14px',
                background: i === activeIndex ? TOKENS.itemFocusBg : 'transparent',
                transition: 'background 80ms linear',
                outline: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      <button
        ref={buttonRef}
        type="button"
        aria-label="Workspace actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="font-serif"
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: TOKENS.buttonBg,
          color: TOKENS.buttonFg,
          border: `1px solid ${TOKENS.buttonRing}`,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)',
          fontSize: 26,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'transform 120ms ease-out',
          transform: open ? 'scale(1.04)' : 'scale(1)',
        }}
      >
        ∀
      </button>
    </div>
  )
}
