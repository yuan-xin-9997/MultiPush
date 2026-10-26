import { createHmac, randomInt } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { Database } from './db'
import { ApiError } from './errors'

export type EmailPurpose = 'register' | 'bind' | 'reset'
export class EmailVerification {
  constructor(private database: Database, private secret: string) {}

  private digest(scope: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${scope}:${code}`).digest('hex')
  }

  async send(email: string, purpose: EmailPurpose, userId = ''): Promise<void> {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
      throw new ApiError(503, 'mail_unavailable', '邮件服务尚未配置，请联系管理员')
    }
    const scope = `${purpose}:${userId}:${email}`
    const code = String(randomInt(100000, 1000000))
    const digest = this.digest(scope, code)
    if (!this.database.saveEmailCode(scope, digest, Date.now())) {
      throw new ApiError(429, 'code_rate_limited', '请等待 60 秒后重新发送验证码')
    }
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: process.env.SMTP_SECURE !== 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      connectionTimeout: 10000, socketTimeout: 15000,
    })
    try {
      const action = { register: '注册账号', bind: '绑定邮箱', reset: '重置密码' }[purpose]
      await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: `MultiPush ${action}验证码`,
        text: `你正在${action}，验证码：${code}。10 分钟内有效，仅可使用一次。若非本人操作，请忽略此邮件。` })
    } catch {
      this.database.clearEmailCode(scope, digest)
      throw new ApiError(503, 'mail_failed', '邮件发送失败，请稍后重试')
    } finally { transport.close() }
  }

  verify(email: string, purpose: EmailPurpose, code: string, userId = ''): void {
    const scope = `${purpose}:${userId}:${email}`
    if (!this.database.consumeEmailCode(scope, this.digest(scope, code))) {
      throw new ApiError(400, 'invalid_code', '验证码错误或已失效，请重新获取')
    }
  }
}
