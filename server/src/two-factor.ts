import type { TwoFactorSetup, TwoFactorStatus } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError } from './errors'
import { decryptPublisherSecret, encryptPublisherSecret, loadPublisherKey } from './publisher-session'
import {
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  recoveryCodeMatches,
  totpUri,
  verifyTotp,
} from './totp'

const RECOVERY_CODE_COUNT = 10

export class TwoFactorService {
  private key: Buffer | null = null

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {}

  /** Load lazily so auth-only test setups without a dataDir stay usable. */
  private encryptionKey(): Buffer {
    if (!this.key) {
      if (!this.config.dataDir) throw new ApiError(500, 'two_factor_unavailable', '服务器数据目录未配置，无法启用两步验证')
      this.key = loadPublisherKey(this.config.dataDir, 'totp')
    }
    return this.key
  }

  status(userId: string): TwoFactorStatus {
    const record = this.database.getTotp(userId)
    return { enabled: record?.enabled === true, recoveryCodesLeft: record?.recoveryHashes.length ?? 0 }
  }

  isEnabled(userId: string): boolean {
    return this.database.getTotp(userId)?.enabled === true
  }

  /** Create a pending secret; it only becomes active after `/enable`. */
  setup(userId: string, account: string): TwoFactorSetup {
    const existing = this.database.getTotp(userId)
    if (existing?.enabled) throw new ApiError(409, 'two_factor_enabled', '两步验证已开启，请先关闭再重新设置')
    const secret = generateTotpSecret()
    this.database.saveTotp(userId, {
      encryptedSecret: encryptPublisherSecret(secret, this.encryptionKey(), userId),
      enabled: false,
      recoveryHashes: [],
    })
    return { secret, otpauthUrl: totpUri(secret, account) }
  }

  /** Confirm the first code and return the one-time recovery codes. */
  enable(userId: string, code: string): { recoveryCodes: string[] } {
    const record = this.database.getTotp(userId)
    if (!record) throw new ApiError(400, 'two_factor_not_setup', '请先生成两步验证密钥')
    if (record.enabled) throw new ApiError(409, 'two_factor_enabled', '两步验证已开启')
    const secret = this.decryptSecret(userId, record.encryptedSecret)
    if (!verifyTotp(secret, code)) throw new ApiError(400, 'two_factor_code_invalid', '验证码不正确，请确认手机时间后重试')
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())
    this.database.saveTotp(userId, {
      encryptedSecret: record.encryptedSecret,
      enabled: true,
      recoveryHashes: recoveryCodes.map(code => hashRecoveryCode(code, this.encryptionKey())),
    })
    return { recoveryCodes }
  }

  /** Verify a TOTP code or a recovery code; a used recovery code is consumed. */
  verify(userId: string, code: string): boolean {
    const record = this.database.getTotp(userId)
    if (!record?.enabled) return true
    const trimmed = code.trim()
    if (!trimmed) return false
    const secret = this.decryptSecret(userId, record.encryptedSecret)
    if (/^\d{6}$/.test(trimmed) && verifyTotp(secret, trimmed)) return true
    for (const hash of record.recoveryHashes) {
      if (!recoveryCodeMatches(hash, trimmed, this.encryptionKey())) continue
      this.database.saveTotp(userId, {
        encryptedSecret: record.encryptedSecret,
        enabled: true,
        recoveryHashes: record.recoveryHashes.filter(item => item !== hash),
      })
      return true
    }
    return false
  }

  disable(userId: string): void {
    this.database.deleteTotp(userId)
  }

  /** Replace all recovery codes; the caller must verify the password and a code. */
  regenerateRecoveryCodes(userId: string): string[] {
    const record = this.database.getTotp(userId)
    if (!record?.enabled) throw new ApiError(409, 'two_factor_disabled', '两步验证尚未开启')
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())
    this.database.saveTotp(userId, {
      encryptedSecret: record.encryptedSecret,
      enabled: true,
      recoveryHashes: recoveryCodes.map(code => hashRecoveryCode(code, this.encryptionKey())),
    })
    return recoveryCodes
  }

  private decryptSecret(userId: string, encrypted: string): string {
    try {
      return decryptPublisherSecret<string>(encrypted, this.encryptionKey(), userId)
    } catch {
      throw new ApiError(409, 'two_factor_corrupt', '两步验证密钥无法读取，请重新设置')
    }
  }
}
