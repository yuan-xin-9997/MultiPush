import {
  publishXiaohongshuGallery,
  findXiaohongshuPublication,
  verifyXiaohongshuPublishedPage,
  validateXiaohongshuPublishedUrl,
} from "./platforms/xiaohongshu/publish.ts";
import {
  publishWechatArticle,
  findPublishedArticle,
  verifyWechatPublishedPage,
  validateWechatPublishedUrl,
} from "./platforms/wechat/publish.ts";
import {
  publishZhihuArticle,
  verifyZhihuPublishedPage,
  validateZhihuPublishedUrl,
} from "./platforms/zhihu/publish.ts";
import { z, ZodError } from "zod";
import {
  exportPortableContents,
  importImages,
  importPortableContents,
} from "./assets.ts";
import { validateZhihuTopics } from "./platforms/zhihu/topics.ts";
import { open, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Store, PUBLICATION_SUBMISSION_MESSAGE } from "@turbopush/database";
import {
  rpcRequest,
  douyinVideoDraftVerified,
  xiaohongshuGalleryDraftVerified,
  type Account,
  type DraftProgress,
  type RpcResponse,
  type Task,
} from "@turbopush/shared";
import { anyContentArchive } from "@turbopush/shared";
import { BrowserManager } from "./browser-manager.ts";
import { saveZhihuDraft, validateDraftUrl } from "./platforms/zhihu/draft.ts";
import { renderMarkdown } from "./markdown.ts";
import { imagePayload } from "./platforms/wechat/media.ts";
import {
  openWechatDraft,
  saveWechatDraft,
  validateWechatContent,
} from "./platforms/wechat/draft.ts";
import { QueueFailure, TaskQueue, type QueueClock } from "./task-queue.ts";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock.ts";
import {
  detectPlatformLogin,
  type LoginCheckResult,
} from "./platforms/login-status.ts";
import { validateXiaohongshuGallery } from "./platforms/xiaohongshu/schema.ts";
import { validateDouyinVideo } from "./platforms/douyin/schema.ts";
import {
  saveDouyinDraft,
  validateDouyinDraftUrl,
} from "./platforms/douyin/draft.ts";
import {
  saveXiaohongshuDraft,
  prepareXiaohongshuGalleryDraft,
  validateXiaohongshuPublishUrl,
} from "./platforms/xiaohongshu/draft.ts";
import { reportDraftProgress } from "./draft-progress.ts";

export interface DraftExecutionContext {
  signal: AbortSignal;
  checkpoint: (url: string) => void;
  markExternalWrite: () => void;
  progress: (event: DraftProgress) => void;
}

export interface ServiceOptions {
  clock?: QueueClock;
  pollIntervalMs?: number;
  draftExecutor?: (
    task: Task,
    context: DraftExecutionContext,
  ) => Promise<{ url: string }>;
  loginDetector?: (account: Account) => Promise<LoginCheckResult>;
  publishExecutor?: (
    task: Task,
    markSubmitted: () => void,
  ) => Promise<{ url: string }>;
}

const idParam = z.object({ id: z.uuid() }).strict();
const portableFileParam = z.object({ path: z.string().min(1) }).strict();
const MAX_PORTABLE_FILE_BYTES = 70 * 1024 * 1024;
export class Service {
  readonly store: Store;
  readonly browsers: BrowserManager;
  private publishingAccounts = new Set<string>();
  private readonly queue: TaskQueue;
  private readonly clock: QueueClock;
  private readonly pollIntervalMs: number;
  private readonly draftExecutor: ServiceOptions["draftExecutor"];
  private readonly loginDetector: ServiceOptions["loginDetector"];
  private readonly publishExecutor: ServiceOptions["publishExecutor"];
  private readonly publicationCompletions = new Set<Promise<unknown>>();
  private readonly preparedPublications = new Map<
    string,
    import("playwright").Page
  >();
  private readonly externalWriting = new Set<string>();
  private readonly queuedTaskIds = new Set<string>();
  private readonly queueCompletions = new Set<Promise<void>>();
  private pollTimer: unknown;
  private closed = false;
  private readonly instanceLock: InstanceLock;
  constructor(directory: string, options: ServiceOptions = {}) {
    this.instanceLock = acquireInstanceLock(directory);
    try {
      this.store = new Store(directory);
      this.browsers = new BrowserManager(directory);
    } catch (error) {
      this.instanceLock.release();
      throw error;
    }
    this.clock = options.clock ?? {
      now: Date.now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.draftExecutor = options.draftExecutor;
    this.loginDetector = options.loginDetector;
    this.publishExecutor = options.publishExecutor;
    // Retry timing is persisted by Store; each queue entry represents one attempt.
    this.queue = new TaskQueue({ clock: this.clock, maxRetries: 0 });
    this.queue.start();
    this.pollTimer = this.clock.setTimeout(
      this.pollDueTasks,
      this.pollIntervalMs,
    );
  }
  async dispatch(input: unknown): Promise<RpcResponse> {
    let id: string | number | null = null;
    try {
      const req = rpcRequest.parse(input);
      id = req.id;
      let result: unknown;
      switch (req.method) {
        case "assets.importImages": {
          const params = z
            .object({ paths: z.array(z.string().min(1)).min(1).max(21) })
            .strict()
            .parse(req.params);
          result = await importImages(this.store.directory, params.paths);
          break;
        }
        case "snapshot":
          result = this.store.snapshot();
          break;
        case "account.create":
          result = this.store.createAccount(req.params);
          break;
        case "content.create":
          result = this.store.createContent(req.params);
          break;
        case "content.import": {
          const archive = anyContentArchive.parse(req.params);
          const contents =
            archive.version === 2
              ? await importPortableContents(
                  this.store.directory,
                  archive.contents,
                  archive.assets,
                )
              : archive.contents;
          result = this.store.transaction(() =>
            contents.map((content) => this.store.createContent(content)),
          );
          break;
        }
        case "content.exportPortable": {
          const params = z
            .object({ ids: z.array(z.uuid()).min(1).max(100) })
            .strict()
            .parse(req.params);
          const byId = new Map(
            this.store.contents().map((content) => [content.id, content]),
          );
          const contents = [...new Set(params.ids)].map((contentId) => {
            const content = byId.get(contentId);
            if (!content) throw new Error("内容不存在");
            return content;
          });
          result = await exportPortableContents(contents);
          break;
        }
        case "content.exportPortableFile": {
          const params = z
            .object({
              path: z.string().min(1),
              ids: z.array(z.uuid()).min(1).max(100),
            })
            .strict()
            .parse(req.params);
          assertAbsolutePortablePath(params.path);
          const byId = new Map(
            this.store.contents().map((content) => [content.id, content]),
          );
          const contents = [...new Set(params.ids)].map((contentId) => {
            const content = byId.get(contentId);
            if (!content) throw new Error("内容不存在");
            return content;
          });
          const archive = await exportPortableContents(contents);
          const serialized = `${JSON.stringify(archive)}\n`;
          const size = Buffer.byteLength(serialized);
          if (size > MAX_PORTABLE_FILE_BYTES)
            throw new Error("归档文件不能超过70MB，请减少内容或图片后重试");
          try {
            await writeFile(params.path, serialized, {
              encoding: "utf8",
              flag: "wx",
              mode: 0o600,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
              throw new Error("目标归档文件已存在，拒绝覆盖");
            throw error;
          }
          result = { path: params.path, size };
          break;
        }
        case "content.importPortableFile": {
          const params = portableFileParam.parse(req.params);
          assertAbsolutePortablePath(params.path);
          let handle;
          try {
            handle = await open(params.path, "r");
          } catch {
            throw new Error("无法读取归档文件，请检查文件是否存在");
          }
          let input: unknown;
          try {
            const file = await handle.stat();
            if (!file.isFile()) throw new Error("归档路径必须指向普通文件");
            if (file.size > MAX_PORTABLE_FILE_BYTES)
              throw new Error("归档文件不能超过70MB");
            const serialized = await handle.readFile("utf8");
            if (Buffer.byteLength(serialized) > MAX_PORTABLE_FILE_BYTES)
              throw new Error("归档文件不能超过70MB");
            try {
              input = JSON.parse(serialized);
            } catch {
              throw new Error("归档文件不是有效JSON");
            }
          } finally {
            await handle.close();
          }
          const archive = anyContentArchive.parse(input);
          const contents =
            archive.version === 2
              ? await importPortableContents(
                  this.store.directory,
                  archive.contents,
                  archive.assets,
                )
              : archive.contents;
          result = this.store.transaction(() =>
            contents.map((content) => this.store.createContent(content)),
          );
          break;
        }
        case "content.update": {
          const params = z
            .object({ id: z.uuid(), content: z.unknown() })
            .strict()
            .parse(req.params);
          result = this.store.updateContent(params.id, params.content);
          break;
        }
        case "campaign.create":
          result = this.store.createCampaign(req.params);
          break;
        case "task.cancel":
          {
            const taskId = idParam.parse(req.params).id;
            const task = this.store.task(taskId);
            if (this.externalWriting.has(taskId))
              throw new Error(
                "草稿已进入远端写入，不能安全取消；请等待结果或人工核对",
              );
            if (this.queue.cancel(taskId)) {
              this.store.transition(taskId, "cancelled", "已取消队列任务");
              result = this.store.task(taskId);
            } else result = this.store.cancel(taskId);
          }
          break;
        case "task.enqueueDraft": {
          const taskId = idParam.parse(req.params).id;
          const task = this.store.task(taskId);
          this.assertDraftCapable(task);
          const queued = this.claimAndEnqueue(taskId);
          result = {
            accepted: true,
            queued,
            task: this.store.task(taskId),
          };
          break;
        }
        case "account.open": {
          await this.browsers.open(
            this.store.account(idParam.parse(req.params).id),
          );
          result = { message: "独立浏览器已打开；登录状态仍待适配器验证" };
          break;
        }
        case "account.close": {
          const accountId = this.store.account(idParam.parse(req.params).id).id;
          if (this.publishingAccounts.has(accountId))
            throw new Error("账号仍在执行，请等待任务完成后关闭");
          await this.browsers.close(accountId);
          for (const [taskId] of this.preparedPublications) {
            const task = this.store.task(taskId);
            if (task.accountId !== accountId) continue;
            this.preparedPublications.delete(taskId);
            if (task.status === "publication_ready")
              this.store.transition(
                taskId,
                "intervention_required",
                "待发表编辑器会话已中断；未自动发表，请人工核对",
              );
          }
          result = { closed: true };
          break;
        }
        case "account.checkLogin": {
          const account = this.store.account(idParam.parse(req.params).id);
          this.store.updateAccountLoginStatus(
            account.id,
            "checking",
            "正在只读检测登录状态",
            new Date(this.clock.now()),
          );
          let checked: LoginCheckResult;
          try {
            if (this.loginDetector) checked = await this.loginDetector(account);
            else {
              const context = await this.browsers.open(account);
              const page = context.pages()[0] ?? (await context.newPage());
              checked = await detectPlatformLogin(page, account.platform);
            }
          } catch {
            checked = {
              status: "intervention_required",
              message: "检测过程超时或网络异常，无法确认登录是否过期",
            };
          }
          result = this.store.updateAccountLoginStatus(
            account.id,
            checked.status,
            checked.message,
            new Date(this.clock.now()),
          );
          break;
        }
        case "diagnostics.network": {
          const account = this.store.account(idParam.parse(req.params).id);
          result = this.browsers.network(account.id);
          break;
        }
        case "diagnostics.inspect": {
          result = await this.browsers.inspect(
            this.store.account(idParam.parse(req.params).id),
          );
          break;
        }
        case "diagnostics.capture":
          result = await this.browsers.capture(
            this.store.account(idParam.parse(req.params).id).id,
          );
          break;
        case "task.openDraft": {
          const task = this.store.task(idParam.parse(req.params).id);
          if (
            !["zhihu", "wechat-official", "xiaohongshu", "douyin"].includes(
              task.platform,
            ) ||
            !task.resultUrl
          )
            throw new Error("该任务没有已记录的可用草稿链接");
          const context = await this.browsers.open(
            this.store.account(task.accountId),
          );
          if (task.platform === "wechat-official") {
            try {
              await openWechatDraft(context, task.resultUrl);
            } catch {
              throw new Error("公众号草稿打开失败，请检查独立窗口登录状态");
            }
            result = { opened: true };
            break;
          }
          if (task.platform === "xiaohongshu") {
            const page = await context.newPage();
            await page.goto(validateXiaohongshuPublishUrl(task.resultUrl), {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            result = { opened: true };
            break;
          }
          if (task.platform === "douyin") {
            const page = await context.newPage();
            await page.goto(validateDouyinDraftUrl(task.resultUrl), {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            result = { opened: true };
            break;
          }
          const page = await context.newPage();
          await page.goto(validateDraftUrl(task.resultUrl), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          result = { opened: true };
          break;
        }
        case "task.events": {
          const taskId = idParam.parse(req.params).id;
          result = this.store.events(taskId);
          break;
        }
        case "task.preparePublish": {
          const params = z
            .object({
              id: z.uuid(),
              accountId: z.uuid(),
              title: z.string(),
              confirmed: z.literal(true),
              restore: z.literal(true).optional(),
            })
            .strict()
            .parse(req.params);
          const task = this.store.task(params.id);
          const restoring =
            params.restore === true &&
            task.status === "intervention_required" &&
            task.message === "待发表编辑器会话已中断；未自动发表，请人工核对";
          this.assertNoPublicationAttempt(task);
          if (
            this.closed ||
            task.platform !== "xiaohongshu" ||
            task.content.type !== "gallery" ||
            (!restoring &&
              (task.status !== "pending" ||
                this.store.hasDraftAttempt(task.id)))
          )
            throw new Error("仅允许为从未尝试的小红书图文任务准备编辑器");
          if (
            params.accountId !== task.accountId ||
            params.title !== task.content.title
          )
            throw new Error("准备发布确认的账号或标题不一致");
          if (process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH !== "1")
            throw new Error("实验发布开关未开启");
          await validateXiaohongshuGallery(task.content);
          if (task.content.tags.length)
            throw new Error("小红书话题控件尚未验证");
          if (
            this.publishingAccounts.has(task.accountId) ||
            (!restoring &&
              (this.store.task(task.id).status !== "pending" ||
                this.store.hasDraftAttempt(task.id)))
          )
            throw new Error("任务或账号状态已改变");
          this.publishingAccounts.add(task.accountId);
          const completion = this.preparePublication(task);
          this.publicationCompletions.add(completion);
          try {
            result = await completion;
          } finally {
            this.publicationCompletions.delete(completion);
          }
          break;
        }
        case "task.confirmPublicationReview": {
          const params = z
            .object({
              id: z.uuid(),
              accountId: z.uuid(),
              title: z.string(),
              confirmed: z.literal(true),
            })
            .strict()
            .parse(req.params);
          const task = this.store.task(params.id);
          if (
            this.closed ||
            task.status !== "intervention_required" ||
            this.publishingAccounts.has(task.accountId) ||
            !this.store.hasPublicationAttempt(task.id) ||
            params.accountId !== task.accountId ||
            params.title !== task.content.title
          )
            throw new Error("人工确认的任务、账号、标题或提交状态不匹配");
          const candidate = this.store
            .events(task.id)
            .filter((event) => event.message.startsWith("公开结果链接待回读："))
            .at(-1)
            ?.message.slice("公开结果链接待回读：".length);
          if (!candidate)
            throw new Error("必须先只读取得平台公开链接，才能记录人工核对");
          const url =
            task.platform === "xiaohongshu"
              ? validateXiaohongshuPublishedUrl(candidate)
              : task.platform === "wechat-official"
                ? validateWechatPublishedUrl(candidate)
                : validateZhihuPublishedUrl(candidate, task.resultUrl!);
          this.store.transaction(() => {
            this.store.db
              .prepare("UPDATE tasks SET result_url=? WHERE id=?")
              .run(url, task.id);
            this.store.transition(
              task.id,
              "succeeded",
              "用户人工确认发布页正文与图片顺序正确；自动公开页回读受平台限制，未重复提交",
            );
          });
          result = this.store.task(task.id);
          break;
        }
        case "task.verifyPublication": {
          const params = z
            .object({
              id: z.uuid(),
              accountId: z.uuid(),
              url: z.string().optional(),
            })
            .strict()
            .parse(req.params);
          const task = this.store.task(params.id);
          if (
            this.closed ||
            params.accountId !== task.accountId ||
            !this.store.hasPublicationAttempt(task.id) ||
            this.publishingAccounts.has(task.accountId)
          )
            throw new Error("任务未提交、账号不一致或仍在执行");
          this.publishingAccounts.add(task.accountId);
          const completion = (async () => {
            try {
              const recorded = this.store
                .events(task.id)
                .filter((event) =>
                  event.message.startsWith("公开结果链接待回读："),
                )
                .at(-1)
                ?.message.slice("公开结果链接待回读：".length);
              const candidate =
                params.url ??
                (task.platform === "xiaohongshu" ? undefined : recorded) ??
                (task.platform === "xiaohongshu"
                  ? await findXiaohongshuPublication(
                      await this.browsers.open(
                        this.store.account(task.accountId),
                      ),
                      task,
                    )
                  : task.platform === "wechat-official"
                    ? await findPublishedArticle(
                        await this.browsers.open(
                          this.store.account(task.accountId),
                        ),
                        task,
                      )
                    : undefined) ??
                (task.platform === "zhihu"
                  ? task.resultUrl?.replace(/\/edit$/, "")
                  : undefined);
              if (!candidate)
                throw new Error(
                  "尚未取得公开链接，请从平台发表记录核对后提供链接",
                );
              const url =
                task.platform === "xiaohongshu"
                  ? validateXiaohongshuPublishedUrl(candidate)
                  : task.platform === "wechat-official"
                    ? validateWechatPublishedUrl(candidate)
                    : validateZhihuPublishedUrl(candidate, task.resultUrl!);
              const context = await this.browsers.open(
                this.store.account(task.accountId),
              );
              this.store.transition(
                task.id,
                task.status,
                "公开结果链接待回读：" + url,
              );
              const page = await context.newPage();
              await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
              await page.reload({
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
              await (
                task.platform === "xiaohongshu"
                  ? verifyXiaohongshuPublishedPage
                  : task.platform === "wechat-official"
                    ? verifyWechatPublishedPage
                    : verifyZhihuPublishedPage
              )(page, task);
              this.store.transaction(() => {
                this.store.db
                  .prepare("UPDATE tasks SET result_url=? WHERE id=?")
                  .run(url, task.id);
                this.store.transition(
                  task.id,
                  "succeeded",
                  "公开页只读回读通过，标题、正文和图片已核对",
                );
              });
              return this.store.task(task.id);
            } finally {
              this.publishingAccounts.delete(task.accountId);
            }
          })();
          this.publicationCompletions.add(completion);
          try {
            result = await completion;
          } finally {
            this.publicationCompletions.delete(completion);
          }
          break;
        }
        case "task.publish": {
          const params = z
            .object({
              id: z.uuid(),
              accountId: z.uuid(),
              title: z.string(),
              confirmed: z.literal(true),
            })
            .strict()
            .parse(req.params);
          const task = this.store.task(params.id);
          if (this.closed) throw new Error("服务正在关闭");
          if (!(
            (["zhihu", "wechat-official"].includes(task.platform) &&
              task.content.type === "article") ||
            (task.platform === "xiaohongshu" && task.content.type === "gallery")
          ))
            throw new Error(
              "当前实验公开发布仅接入知乎、公众号文章；其他平台尚未完成",
            );
          this.assertNoPublicationAttempt(task);
          if (
            task.platform === "xiaohongshu"
              ? task.status !== "publication_ready" ||
                !this.preparedPublications.has(task.id)
              : task.status !== "draft_saved" || !task.resultUrl
          )
            throw new Error(
              "仅允许发布已保存并回读通过的草稿；结果未知的任务禁止重试",
            );
          if (
            params.accountId !== task.accountId ||
            params.title !== task.content.title
          )
            throw new Error("确认的账号或标题与任务快照不一致");
          if (
            !this.publishExecutor &&
            process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH !== "1"
          )
            throw new Error("公开发布尚待真实账号验收；需显式开启实验发布开关");
          if (this.publishingAccounts.has(task.accountId))
            throw new Error("同账号已有任务执行中");
          this.publishingAccounts.add(task.accountId);
          const completion = this.publishTask(task);
          this.publicationCompletions.add(completion);
          try {
            result = await completion;
          } finally {
            this.publicationCompletions.delete(completion);
          }
          break;
        }
        case "task.repairDraft":
        case "task.saveDraft": {
          const repair = req.method === "task.repairDraft";
          const request = repair
            ? z
                .object({
                  id: z.uuid(),
                  accountId: z.uuid(),
                  title: z.string(),
                  confirmed: z.literal(true),
                })
                .strict()
                .parse(req.params)
            : idParam.parse(req.params);
          const task = this.store.task(request.id);
          if (repair) {
            if (task.platform !== "zhihu" || !task.resultUrl)
              throw new Error("仅允许修复具有明确草稿ID的知乎任务");
            if (
              !("accountId" in request) ||
              !("title" in request) ||
              request.accountId !== task.accountId ||
              request.title !== task.content.title
            )
              throw new Error("修复确认账号或标题不一致");
          }
          this.assertNoPublicationAttempt(task);
          const xiaohongshu =
            task.platform === "xiaohongshu" && task.content.type === "gallery";
          const douyin =
            task.platform === "douyin" && task.content.type === "video";
          if (
            !xiaohongshu &&
            !douyin &&
            (!["zhihu", "wechat-official"].includes(task.platform) ||
              task.content.type !== "article")
          )
            throw new Error(
              "当前仅支持知乎、公众号文章、小红书图文及抖音私密视频草稿",
            );
          const wechat = task.platform === "wechat-official";
          if (xiaohongshu) await validateXiaohongshuGallery(task.content);
          else if (douyin) {
            await validateDouyinVideo(task.content);
            if (task.content.tags.length)
              throw new Error("抖音话题控件尚未验证，首版草稿暂不接受标签");
          } else if (!wechat) validateZhihuTopics(task.content.tags);
          const platformName = wechat
            ? "公众号"
            : xiaohongshu
              ? "小红书"
              : douyin
                ? "抖音"
                : "知乎";
          if (
            ![
              "pending",
              "failed",
              "intervention_required",
              ...(repair ? ["draft_saved"] : []),
            ].includes(task.status)
          )
            throw new Error("当前任务不能保存草稿；已排期任务请另建即时任务");
          if (this.store.hasDraftAttempt(task.id) && !task.resultUrl)
            throw new Error(
              "上次草稿结果未知且未取得链接，请先人工检查平台草稿箱，避免重复创建",
            );
          if (this.publishingAccounts.has(task.accountId))
            throw new Error("此账号正在执行其他草稿任务，请稍后再试");
          if (xiaohongshu) {
            // Full schema and all local image bytes were checked above.
          } else if (wechat) {
            validateWechatContent(task.content);
            if (task.content.bodyFormat === "markdown")
              renderMarkdown(task.content.body);
            await Promise.all(
              [
                ...task.content.images,
                ...(task.content.cover ? [task.content.cover] : []),
              ].map(imagePayload),
            );
            // Re-check after local asynchronous validation before entering the write phase.
            if (
              this.publishingAccounts.has(task.accountId) ||
              ![
                "pending",
                "failed",
                "intervention_required",
                ...(repair ? ["draft_saved"] : []),
              ].includes(this.store.task(task.id).status)
            )
              throw new Error("任务或账号状态已改变，请刷新");
          } else {
            if (task.content.bodyFormat === "markdown")
              renderMarkdown(task.content.body);
            await Promise.all(
              [
                ...task.content.images,
                ...(task.content.cover ? [task.content.cover] : []),
              ].map(imagePayload),
            );
            if (
              this.publishingAccounts.has(task.accountId) ||
              ![
                "pending",
                "failed",
                "intervention_required",
                ...(repair ? ["draft_saved"] : []),
              ].includes(this.store.task(task.id).status)
            )
              throw new Error("任务或账号状态已改变，请刷新");
          }
          if (
            this.publishingAccounts.has(task.accountId) ||
            ![
              "pending",
              "failed",
              "intervention_required",
              ...(repair ? ["draft_saved"] : []),
            ].includes(this.store.task(task.id).status)
          )
            throw new Error("任务或账号状态已改变，请刷新");
          if (
            !wechat &&
            !xiaohongshu &&
            !douyin &&
            ([...task.content.title].length > 100 ||
              task.content.images.length > 20 ||
              task.content.video)
          )
            throw new Error(
              "知乎草稿标题最多100字、正文图片最多20张，暂不支持视频",
            );
          this.publishingAccounts.add(task.accountId);
          try {
            this.store.transaction(() =>
              this.store.transition(
                task.id,
                "publishing",
                `正在保存${platformName}测试版草稿，不会公开发布`,
              ),
            );
            const context = await this.browsers.open(
              this.store.account(task.accountId),
            );
            const options = {
              ...(repair ? { repairMedia: true } : {}),
              draftUrl: task.resultUrl ?? undefined,
              checkpoint: (url: string) =>
                this.store.checkpointDraft(task.id, url),
              onProgress: (event: DraftProgress) =>
                reportDraftProgress(
                  (progress) => this.store.progress(task.id, progress),
                  event,
                ),
            };
            const saved = wechat
              ? await saveWechatDraft(context, task.content, options)
              : xiaohongshu
                ? await saveXiaohongshuDraft(
                    context,
                    task.content,
                    undefined,
                    options.onProgress,
                  )
                : douyin
                  ? await saveDouyinDraft(
                      context,
                      task.content,
                      undefined,
                      options.onProgress,
                    )
                  : await saveZhihuDraft(context, task.content, options);
            this.store.transaction(() => {
              this.store.checkpointDraft(task.id, saved.url);
              this.store.transition(
                task.id,
                "draft_saved",
                `${platformName}草稿已保存，远端编辑页回读一致；未公开发布`,
              );
            });
            result = this.store.task(task.id);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "草稿保存失败";
            this.store.transaction(() =>
              this.store.transition(task.id, "intervention_required", message),
            );
            throw error;
          } finally {
            this.publishingAccounts.delete(task.accountId);
          }
          break;
        }
        case "task.preflight": {
          const task = this.store.task(idParam.parse(req.params).id);
          this.assertNoPublicationAttempt(task);
          if (
            ![
              "pending",
              "scheduled",
              "failed",
              "intervention_required",
            ].includes(task.status)
          )
            throw new Error("当前任务不能执行预检");
          if (task.platform === "xiaohongshu")
            await validateXiaohongshuGallery(task.content);
          else if (task.platform === "douyin") {
            await validateDouyinVideo(task.content);
            if (task.content.tags.length)
              throw new Error("抖音话题控件尚未验证，首版草稿暂不接受标签");
          } else
            for (const path of [
              ...task.content.images,
              task.content.video,
              task.content.cover,
            ].filter((p): p is string => !!p)) {
              try {
                if (!(await stat(path)).isFile()) throw new Error();
              } catch {
                throw new Error(
                  "素材不存在或不是文件，请修正内容中的素材路径后重新创建任务",
                );
              }
            }
          this.store.transaction(() => {
            if (
              ![
                "pending",
                "scheduled",
                "failed",
                "intervention_required",
              ].includes(this.store.task(task.id).status)
            )
              throw new Error("预检期间任务状态已改变，请刷新");
            this.store.transition(
              task.id,
              "intervention_required",
              task.platform === "xiaohongshu"
                ? "小红书图文本地检查通过；远端草稿适配器尚未验证，未打开浏览器或写入平台"
                : task.platform === "douyin"
                  ? "抖音视频本地检查通过；可保存仅自己可见草稿，绝不公开发布"
                  : "本地字段与素材检查通过，未执行远端写入；知乎、公众号文章可手动保存草稿",
            );
          });
          result = this.store.task(task.id);
          break;
        }
      }
      return { id, result };
    } catch (error) {
      return {
        id,
        error: {
          code:
            error instanceof ZodError ? "VALIDATION_ERROR" : "OPERATION_FAILED",
          message:
            error instanceof ZodError
              ? error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("；")
              : error instanceof Error
                ? error.message
                : "操作失败",
        },
      };
    }
  }
  private async preparePublication(task: Task) {
    try {
      this.store.transaction(() =>
        this.store.transition(
          task.id,
          "publishing",
          "正在准备小红书编辑器和媒体；不会公开发布",
        ),
      );
      this.externalWriting.add(task.id);
      const context = await this.browsers.open(
        this.store.account(task.accountId),
      );
      const prepared = await prepareXiaohongshuGalleryDraft(
        context,
        task.content,
      );
      this.preparedPublications.set(task.id, prepared.page);
      this.store.transition(
        task.id,
        "publication_ready",
        "小红书图片上传和编辑器已准备，待逐图核对后确认发表；尚未公开发布",
      );
      return this.store.task(task.id);
    } catch (error) {
      this.store.transition(
        task.id,
        "intervention_required",
        "小红书编辑器或上传证明未通过，未点击公开发布；请核对，禁止自动重试",
      );
      throw error;
    } finally {
      this.externalWriting.delete(task.id);
      this.publishingAccounts.delete(task.accountId);
    }
  }
  private async publishTask(task: Task) {
    let submitted = false;
    const markSubmitted = () => {
      // Persist before the click: a process interruption can never authorize a repeat.
      this.store.transaction(() =>
        this.store.transition(
          task.id,
          "publishing",
          PUBLICATION_SUBMISSION_MESSAGE,
        ),
      );
      submitted = true;
      this.externalWriting.add(task.id);
    };
    try {
      const published = this.publishExecutor
        ? await this.publishExecutor(task, markSubmitted)
        : task.platform === "xiaohongshu"
          ? await publishXiaohongshuGallery(
              this.preparedPublications.get(task.id)!,
              task,
              markSubmitted,
              (url) => {
                if (!submitted) throw new Error("缺少提交检查点");
                this.store.transition(
                  task.id,
                  "publishing",
                  "公开结果链接待回读：" + validateXiaohongshuPublishedUrl(url),
                );
              },
            )
          : await (
              task.platform === "wechat-official"
                ? publishWechatArticle
                : publishZhihuArticle
            )(
              await this.browsers.open(this.store.account(task.accountId)),
              task,
              markSubmitted,
            );
      if (!submitted) throw new Error("发布适配器没有记录提交检查点");
      const url =
        task.platform === "wechat-official"
          ? validateWechatPublishedUrl(published.url)
          : task.platform === "xiaohongshu"
            ? validateXiaohongshuPublishedUrl(published.url)
            : validateZhihuPublishedUrl(published.url, task.resultUrl!);
      this.store.transaction(() => {
        this.store.db
          .prepare("UPDATE tasks SET result_url=? WHERE id=?")
          .run(url, task.id);
        this.store.transition(
          task.id,
          "succeeded",
          "公开发布成功，发布页已刷新核对标题、正文与图片",
        );
      });
      return this.store.task(task.id);
    } catch (error) {
      if (submitted) {
        this.store.transition(
          task.id,
          "intervention_required",
          "已提交公开发布，但未取得可靠发布结果；请核对平台，禁止重复提交",
        );
        throw new Error("公开发布结果未知，请人工核对，禁止自动重试", {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (submitted) this.preparedPublications.delete(task.id);
      this.externalWriting.delete(task.id);
      this.publishingAccounts.delete(task.accountId);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.queue.stop();
    // Local/waiting work is safe to cancel. Once a remote write has started we
    // must let it settle so shutdown cannot disguise an unknown remote result
    // as a local cancellation.
    for (const id of this.queuedTaskIds)
      if (!this.externalWriting.has(id)) this.queue.cancel(id);
    await Promise.allSettled([
      ...this.queueCompletions,
      ...this.publicationCompletions,
    ]);
    try {
      await this.browsers.shutdown();
    } finally {
      try {
        this.store.close();
      } finally {
        this.instanceLock.release();
      }
    }
  }

  private assertNoPublicationAttempt(task: Task) {
    if (this.store.hasPublicationAttempt(task.id))
      throw new Error(
        "该任务已提交过公开发布；禁止重试或重新保存草稿，请人工核对平台",
      );
  }
  private assertDraftCapable(task: Task) {
    this.assertNoPublicationAttempt(task);
    if (!this.isDraftCapable(task))
      throw new Error("该内容类型尚无已验证草稿适配器；绝不公开发布");
  }

  private isDraftCapable(task: Task) {
    return (
      (task.content.type === "article" &&
        ["zhihu", "wechat-official"].includes(task.platform)) ||
      (xiaohongshuGalleryDraftVerified &&
        task.platform === "xiaohongshu" &&
        task.content.type === "gallery") ||
      (douyinVideoDraftVerified &&
        task.platform === "douyin" &&
        task.content.type === "video")
    );
  }

  private pollDueTasks = () => {
    if (this.closed) return;
    for (const task of this.store.dueTasks(new Date(this.clock.now()))) {
      if (
        ["scheduled", "retry_wait"].includes(task.status) &&
        this.isDraftCapable(task)
      )
        this.claimAndEnqueue(task.id);
    }
    this.pollTimer = this.clock.setTimeout(
      this.pollDueTasks,
      this.pollIntervalMs,
    );
  };

  private claimAndEnqueue(id: string) {
    if (this.closed || this.queue.has(id)) return false;
    const task = this.store.claimTask(id, new Date(this.clock.now()));
    if (!task) return false;
    const completion = this.queue.enqueue({
      id: task.id,
      accountId: task.accountId,
      run: ({ signal }) => this.executeQueuedDraft(task, signal),
    });
    this.queuedTaskIds.add(task.id);
    const handled = completion.then((outcome) => {
      const current = this.store.task(task.id);
      if (
        ["cancelled", "draft_saved"].includes(current.status) ||
        outcome.state === "succeeded"
      )
        return;
      if (outcome.state === "canceled") {
        this.store.transition(task.id, "cancelled", "已取消队列任务");
        return;
      }
      this.store.recordQueueFailure(
        task.id,
        outcome.kind,
        outcome.kind === "unknown"
          ? "外部草稿写入结果未知，请人工检查草稿箱，禁止自动重试"
          : outcome.error instanceof Error
            ? outcome.error.message
            : "异步草稿任务失败",
        new Date(this.clock.now()),
      );
    });
    const tracked = handled.finally(() => {
      this.queuedTaskIds.delete(task.id);
      this.queueCompletions.delete(tracked);
    });
    this.queueCompletions.add(tracked);
    return true;
  }

  private async executeQueuedDraft(task: Task, signal: AbortSignal) {
    let externalWrite = false;
    let accountLocked = false;
    try {
      this.assertDraftCapable(task);
      if (signal.aborted) throw new Error("队列任务已取消");
      if (task.platform === "wechat-official")
        validateWechatContent(task.content);
      else if (task.platform === "zhihu")
        validateZhihuTopics(task.content.tags);
      else if (task.platform === "xiaohongshu")
        await validateXiaohongshuGallery(task.content);
      else {
        await validateDouyinVideo(task.content);
        if (task.content.tags.length)
          throw new Error("抖音话题控件尚未验证，首版草稿暂不接受标签");
      }
      if (task.content.bodyFormat === "markdown")
        renderMarkdown(task.content.body);
      await Promise.all(
        [
          ...task.content.images,
          ...(task.content.cover ? [task.content.cover] : []),
        ].map(imagePayload),
      );
      if (signal.aborted) throw new Error("队列任务已取消");
      this.store.transition(
        task.id,
        "validating",
        "本地预检通过，正在准备账号草稿会话",
      );
      if (this.publishingAccounts.has(task.accountId))
        throw new QueueFailure("此账号正在执行其他草稿任务", "retryable");
      this.publishingAccounts.add(task.accountId);
      accountLocked = true;
      const markExternalWrite = () => {
        if (externalWrite) return;
        if (signal.aborted) throw new Error("队列任务已取消");
        externalWrite = true;
        this.externalWriting.add(task.id);
        this.store.transition(
          task.id,
          "publishing",
          "正在异步保存测试版草稿，不会公开发布",
        );
      };
      let lastCheckpointUrl: string | undefined;
      const checkpoint = (url: string) => {
        if (url === lastCheckpointUrl) return;
        lastCheckpointUrl = url;
        this.store.checkpointDraft(task.id, url);
        if (externalWrite)
          this.store.transition(
            task.id,
            "publishing",
            "平台草稿地址已确认，正在回读保存结果",
          );
      };
      const progress = (event: DraftProgress) =>
        reportDraftProgress(
          (reported) => this.store.progress(task.id, reported),
          event,
        );
      let saved: { url: string };
      if (this.draftExecutor) {
        saved = await this.draftExecutor(task, {
          signal,
          checkpoint,
          markExternalWrite,
          progress,
        });
      } else {
        markExternalWrite();
        const context = await this.browsers.open(
          this.store.account(task.accountId),
        );
        const options = {
          draftUrl: task.resultUrl ?? undefined,
          checkpoint,
          onProgress: progress,
        };
        saved =
          task.platform === "wechat-official"
            ? await saveWechatDraft(context, task.content, options)
            : task.platform === "xiaohongshu"
              ? await saveXiaohongshuDraft(
                  context,
                  task.content,
                  undefined,
                  progress,
                )
              : task.platform === "douyin"
                ? await saveDouyinDraft(
                    context,
                    task.content,
                    undefined,
                    progress,
                  )
                : await saveZhihuDraft(context, task.content, options);
      }
      checkpoint(saved.url);
      this.store.transition(
        task.id,
        "draft_saved",
        "异步草稿已保存并回读一致；未公开发布",
      );
      return saved;
    } catch (error) {
      if (externalWrite)
        throw new QueueFailure("外部草稿写入结果未知", "unknown", {
          cause: error,
        });
      if (error instanceof QueueFailure) throw error;
      throw new QueueFailure(
        error instanceof Error ? error.message : "异步草稿预检失败",
        "permanent",
        { cause: error },
      );
    } finally {
      this.externalWriting.delete(task.id);
      if (accountLocked) this.publishingAccounts.delete(task.accountId);
    }
  }
}

function assertAbsolutePortablePath(path: string) {
  if (!isAbsolute(path)) throw new Error("归档文件必须使用绝对路径");
}
