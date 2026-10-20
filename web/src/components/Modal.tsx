import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'default' | 'wide' | 'compact'
  closeOnBackdrop?: boolean
  showClose?: boolean
}

export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'default',
  closeOnBackdrop = true,
  showClose = true,
}: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const focusTimer = window.setTimeout(() => panelRef.current?.focus(), 30)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      window.clearTimeout(focusTimer)
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={cn('modal', size === 'wide' && 'modal-wide', size === 'compact' && 'modal-compact')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {title || showClose ? (
          <div className="modal-header">
            <div className="modal-heading">
              {title ? (
                <h2 className="modal-title" id={titleId}>
                  {title}
                </h2>
              ) : null}
              {subtitle ? <div className="modal-subtitle">{subtitle}</div> : null}
            </div>
            {showClose ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm modal-close"
                onClick={onClose}
                aria-label="关闭弹窗"
                title="关闭"
              >
                <X size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={cn('modal-body', !title && 'modal-body-plain')}>{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
