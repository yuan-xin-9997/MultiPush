import { useEffect, useState } from 'react'
import { LoaderCircle, ShieldCheck, Smartphone } from 'lucide-react'
import type { SmsLogin } from '@shared/types'
import Modal from '@/components/Modal'

const PHONE_PATTERN = /^1[3-9]\d{9}$/
const CODE_PATTERN = /^\d{4,8}$/

interface SmsLoginModalProps {
  open: boolean
  onClose: () => void
  platformName: string
  platformLoginUrl: string
  login: SmsLogin | null
  busy: boolean
  error: string
  onStart: (phone: string) => Promise<void>
  onVerify: (code: string) => Promise<void>
  onReset: () => void
}

/**
 * Two-step mobile SMS login: request a code, then submit it while the backend
 * keeps the platform browser alive. The password is never requested or stored.
 */
export default function SmsLoginModal({
  open,
  onClose,
  platformName,
  platformLoginUrl,
  login,
  busy,
  error,
  onStart,
  onVerify,
  onReset,
}: SmsLoginModalProps) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const sent = Boolean(login)

  useEffect(() => {
    setPhone('')
    setCode('')
    setAgreed(false)
    setSeconds(0)
  }, [open])

  useEffect(() => {
    if (!login) {
      setSeconds(0)
      return
    }
    setSeconds(60)
    setCode('')
    const timer = window.setInterval(() => {
      setSeconds((value) => (value > 0 ? value - 1 : 0))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [login?.id])

  useEffect(() => {
    if (login?.status === 'failed' || login?.status === 'expired') setSeconds(0)
  }, [login?.status])

  const canSend = agreed && PHONE_PATTERN.test(phone) && !busy
  const canVerify = CODE_PATTERN.test(code) && !busy

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${platformName}手机验证码登录`}
      subtitle="使用平台官方短信登录，系统只保存登录状态，不会持久保存手机号或验证码。"
      size="compact"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
      }
    >
      <div className="sms-login-form" aria-live="polite">
        {!sent ? (
          <>
            <label className="publish-field">
              手机号
              <span className="sms-login-phone">
                <span className="sms-login-prefix">+86</span>
                <input
                  className="input"
                  value={phone}
                  onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, '')
                    setPhone((digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits).slice(0, 11))
                  }}
                  placeholder="请输入 11 位手机号"
                  inputMode="numeric"
                  autoComplete="tel"
                  disabled={busy}
                  autoFocus
                />
              </span>
            </label>
            <label className="sms-login-agree">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
                disabled={busy}
              />
              <span>
                我已阅读并同意
                <a href={platformLoginUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                  {platformName}的用户协议和隐私政策
                </a>
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={!canSend}
              onClick={() => void onStart(phone)}
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <Smartphone size={16} />}
              {busy ? '正在发送验证码…' : '发送验证码'}
            </button>
          </>
        ) : (
          <>
            <div className="sms-login-sent">
              <Smartphone size={15} />
              <span>验证码已发送至 {login?.phoneMasked}</span>
              <button type="button" className="btn-link" onClick={onReset} disabled={busy}>
                修改手机号
              </button>
            </div>
            <label className="publish-field">
              短信验证码
              <input
                className="input"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="请输入短信中的验证码"
                inputMode="numeric"
                autoComplete="one-time-code"
                disabled={busy}
                autoFocus
              />
            </label>
            <div className="sms-login-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canVerify}
                onClick={() => void onVerify(code)}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
                {busy ? '正在验证…' : '验证并连接'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || seconds > 0}
                onClick={() => void onStart(phone)}
              >
                {seconds > 0 ? `${seconds} 秒后重发` : '重新发送'}
              </button>
            </div>
          </>
        )}
        {error ? <p className="publish-failure-message" role="alert">{error}</p> : null}
        <p className="sms-login-hint">
          遇到滑块、安全验证或平台要求二次确认时，请关闭本窗口改用扫码登录。验证码 5 分钟内有效。
        </p>
      </div>
    </Modal>
  )
}
