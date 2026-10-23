import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DropdownItem {
  key: string
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  submenu?: DropdownItem[]
  onSelect?: () => void
}

export type DropdownEntry = DropdownItem | 'separator'

interface DropdownProps {
  trigger: ReactNode
  items: DropdownEntry[]
  header?: ReactNode
  align?: 'start' | 'end'
  className?: string
  menuClassName?: string
  minWidth?: number
}

export default function Dropdown({
  trigger,
  items,
  header,
  align = 'end',
  className,
  menuClassName,
  minWidth,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return
    const anchor = rootRef.current.getBoundingClientRect()
    const { offsetWidth: width, offsetHeight: height } = menuRef.current
    const left = Math.max(8, Math.min(align === 'start' ? anchor.left : anchor.right - width, window.innerWidth - width - 8))
    const below = anchor.bottom + 6
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6)
    setPosition({ top, left })
  }, [open, align, minWidth, submenu])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  function close() {
    setOpen(false)
    setSubmenu(null)
    setPosition(null)
  }

  function select(item: DropdownItem) {
    if (item.disabled) return
    close()
    item.onSelect?.()
  }

  return (
    <div
      ref={rootRef}
      className={cn('dropdown', className)}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="dropdown-trigger"
        onClick={() => open ? close() : setOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </div>
      {open ? createPortal(
        <div
          ref={menuRef}
          className={cn('dropdown-menu', align === 'start' && 'left', menuClassName)}
          role="menu"
          style={{
            position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, right: 'auto',
            minWidth, maxWidth: 'calc(100vw - 16px)', visibility: position ? 'visible' : 'hidden',
          }}
        >
          {header ? (
            <>
              <div className="dropdown-header">{header}</div>
              <div className="dropdown-separator" />
            </>
          ) : null}
          {items.map((entry, index) => {
            if (entry === 'separator') {
              return <div key={`separator-${index}`} className="dropdown-separator" />
            }

            if (entry.submenu?.length) {
              const expanded = submenu === entry.key
              return (
                <div
                  key={entry.key}
                  className="dropdown-submenu"
                  onMouseEnter={() => { if (window.innerWidth > 640) setSubmenu(entry.key) }}
                  onMouseLeave={() => { if (window.innerWidth > 640) setSubmenu((current) => (current === entry.key ? null : current)) }}
                >
                  <button
                    type="button"
                    className={cn('dropdown-item', 'dropdown-item-submenu', expanded && 'is-open')}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={expanded}
                    onClick={() => setSubmenu(entry.key)}
                  >
                    {entry.icon}
                    <span className="dropdown-item-label">{entry.label}</span>
                    <ChevronRight size={14} className="dropdown-chevron" />
                  </button>
                  {expanded ? (
                    <div
                      className={cn('dropdown-menu', 'dropdown-submenu-menu', align === 'start' && 'to-right')}
                      role="menu"
                    >
                      {entry.submenu.map((child) => (
                        <button
                          key={child.key}
                          type="button"
                          role="menuitem"
                          className={cn('dropdown-item', child.danger && 'danger')}
                          disabled={child.disabled}
                          onClick={() => select(child)}
                        >
                          {child.icon}
                          <span className="dropdown-item-label">{child.label}</span>
                          {child.hint ? <span className="dropdown-item-hint">{child.hint}</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            }

            return (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={cn('dropdown-item', entry.danger && 'danger')}
                disabled={entry.disabled}
                onClick={() => select(entry)}
              >
                {entry.icon}
                <span className="dropdown-item-label">{entry.label}</span>
                {entry.hint ? <span className="dropdown-item-hint">{entry.hint}</span> : null}
              </button>
            )
          })}
        </div>, document.body
      ) : null}
    </div>
  )
}
