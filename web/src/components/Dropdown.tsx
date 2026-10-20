import { useEffect, useRef, useState, type ReactNode } from 'react'
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

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current && !rootRef.current.contains(target)) close()
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
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function close() {
    setOpen(false)
    setSubmenu(null)
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
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </div>
      {open ? (
        <div
          className={cn('dropdown-menu', align === 'start' && 'left', menuClassName)}
          role="menu"
          style={minWidth ? { minWidth } : undefined}
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
                  onMouseEnter={() => setSubmenu(entry.key)}
                  onMouseLeave={() => setSubmenu((current) => (current === entry.key ? null : current))}
                >
                  <button
                    type="button"
                    className={cn('dropdown-item', 'dropdown-item-submenu', expanded && 'is-open')}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={expanded}
                    onClick={() => setSubmenu(expanded ? null : entry.key)}
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
        </div>
      ) : null}
    </div>
  )
}
