import { uploadImages } from "./api";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  platforms,
  type Snapshot,
  type Content,
  type PlatformId,
  type ContentType,
  type DraftProgressStage,
  type TaskEvent,
  type TaskStatus,
} from "@turbopush/shared";
import {
  choosePortableArchiveDestination,
  isDesktopApp,
  pickImages,
  pickPortableArchive,
  rpc,
} from "./api";
import "./style.css";
import { taskCapability } from "./platform-capabilities";
import { chronologicalEvents, queueSummary } from "./task-presentation";

const stateNames: Record<TaskStatus, string> = {
  pending: "待预检",
  scheduled: "等待草稿队列",
  validating: "预检中",
  retry_wait: "等待重试",
  publishing: "保存中",
  intervention_required: "待人工验证",
  cancelled: "已取消",
  failed: "失败",
  succeeded: "已完成",
  draft_saved: "草稿已保存",
  publication_ready: "待发表核对",
};
const typeNames = { article: "长文章", gallery: "图文", video: "视频" };
const progressStageNames: Record<DraftProgressStage, string> = {
  session: "账号会话",
  upload: "素材上传",
  fields: "字段填写",
  privacy: "隐私设置",
  save: "保存草稿",
  verify: "远端回读",
};
type QueueTask = Snapshot["tasks"][number] & {
  attemptCount?: number;
  nextRunAt?: string | null;
};
type LoginStatus =
  | "unknown"
  | "checking"
  | "authenticated"
  | "expired"
  | "intervention_required";
type AccountLoginView = Omit<
  Snapshot["accounts"][number],
  "checkedAt" | "message"
> & {
  loginStatus: LoginStatus;
  checkedAt?: string | null;
  message?: string | null;
};
const loginStatusNames: Record<LoginStatus, string> = {
  unknown: "未检查",
  checking: "检查中",
  authenticated: "已认证",
  expired: "登录已过期",
  intervention_required: "需要人工处理",
};
type View = "overview" | "content" | "accounts" | "tasks";
const views: [View, string, string][] = [
  ["overview", "工作台", "◈"],
  ["content", "内容中心", "▤"],
  ["accounts", "账号管理", "◎"],
  ["tasks", "批量任务", "☷"],
];

function App() {
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<Snapshot>({
    accounts: [],
    contents: [],
    tasks: [],
    platforms,
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [contentId, setContentId] = useState("");
  const [editing, setEditing] = useState<Content | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [timelineTaskId, setTimelineTaskId] = useState<string | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<TaskEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");
  const [type, setType] = useState<ContentType>("article");
  const [accountPlatform, setAccountPlatform] =
    useState<PlatformId>("wechat-official");
  const mounted = useRef(true);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refresh = async () => {
    if (!refreshInFlight.current) {
      refreshInFlight.current = rpc<Snapshot>("snapshot")
        .then((value) => {
          if (!mounted.current) return;
          setData(value);
          setConnected(true);
        })
        .finally(() => {
          refreshInFlight.current = null;
        });
    }
    return refreshInFlight.current;
  };
  useEffect(() => {
    mounted.current = true;
    const poll = () =>
      void refresh().catch((e) => {
        if (!mounted.current) return;
        setError(e instanceof Error ? e.message : "刷新任务状态失败");
        setConnected(false);
      });
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!timelineTaskId || view !== "tasks") return;
    let current = true;
    let firstLoad = true;
    const load = () => {
      if (firstLoad) setTimelineLoading(true);
      void rpc<TaskEvent[]>("task.events", { id: timelineTaskId })
        .then((events) => {
          if (!current) return;
          setTimelineEvents(chronologicalEvents(events));
          setTimelineError("");
        })
        .catch((e) => {
          if (!current) return;
          setTimelineError(e instanceof Error ? e.message : "读取任务事件失败");
        })
        .finally(() => {
          if (!current) return;
          firstLoad = false;
          setTimelineLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [timelineTaskId, view]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  const chosenContent = data.contents.find((c) => c.id === contentId);
  const compatible = data.accounts.filter(
    (a) =>
      chosenContent &&
      platforms
        .find((p) => p.id === a.platform)!
        .types.includes(chosenContent.type),
  );
  const platformName = (id: PlatformId) =>
    platforms.find((p) => p.id === id)!.name;
  const selectedAccounts = data.accounts.filter((account) =>
    selected.includes(account.id),
  );
  const hasUnsupportedSchedule =
    !!scheduledAt &&
    selectedAccounts.some(
      (account) =>
        !chosenContent ||
        !taskCapability(account.platform, chosenContent.type).enqueueDraft,
    );
  const navigate = (target: View) => {
    setView(target);
    setError("");
    setNotice("");
  };
  async function importPickedImages(
    form: HTMLFormElement,
    target: "images" | "cover",
    browserPaths?: string[],
  ) {
    const paths = browserPaths ?? (await pickImages(target === "images"));
    if (paths === null) return;
    if (!paths.length) return;
    const imported = await rpc<string[]>("assets.importImages", { paths });
    if (target === "images") {
      const input = form.elements.namedItem("images") as HTMLTextAreaElement;
      const existing = input.value
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean);
      input.value = [...existing, ...imported].join("\n");
    } else {
      (form.elements.namedItem("cover") as HTMLInputElement).value =
        imported[0];
    }
    setNotice(
      `已选择并托管${imported.length}张图片，原文件保留；请保存内容以记录新路径。`,
    );
  }
  return (
    <div className="app-shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">↗</span>
          <div>
            TurboPush<span className="edition">FORKED · LOCAL FIRST</span>
          </div>
        </div>
        <div className="nav-caption">内容发布空间</div>
        <nav>
          {views.map(([id, name, icon]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
            >
              <span>{icon}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot ${connected ? "on" : ""}`} />
          {connected ? "本地引擎已连接" : "正在连接引擎"}
          <small>v0.0.1 · 技术验证版</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumbs">
            个人工作空间 <span>/</span> {views.find((v) => v[0] === view)![1]}
          </div>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => void action(refresh)}
          >
            刷新数据
          </button>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                CREATE ONCE. DISTRIBUTE THOUGHTFULLY.
              </div>
              <h1>{views.find((v) => v[0] === view)![1]}</h1>
              <p>让每一份内容都有序抵达。素材、账号与任务，保存在你的电脑。</p>
            </div>
            <span className="version">阶段 0 / 基础链路</span>
          </div>
          <div className="banner">
            技术验证版：公众号、知乎文章和小红书图文已接入实验公开发布，需单独确认；平台安全验证可能需要人工处理。创建任务不会公开发布。
          </div>
          {error && (
            <div className="feedback error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="feedback" role="status">
              {notice}
            </div>
          )}
          {view === "overview" && (
            <>
              <div className="metrics">
                {[
                  ["内容资产", data.contents.length, "篇内容，随时准备分发"],
                  ["平台账号", data.accounts.length, "个独立的浏览器空间"],
                  ["发布任务", data.tasks.length, "个本地持久化任务"],
                  [
                    "草稿链路状态",
                    "3 自动 / 1 人工",
                    "知乎、公众号文章和抖音私密视频已验证；小红书图文需人工核图",
                  ],
                ].map(([name, number, desc]) => (
                  <section className="metric" key={name}>
                    <label>{name}</label>
                    <strong>{number}</strong>
                    <small>{desc}</small>
                  </section>
                ))}
              </div>
              <div className="section-title">
                <h2>从一篇内容开始</h2>
                <span>三步组织你的发布流程</span>
              </div>
              <div className="steps">
                {[
                  [
                    "01",
                    "连接你的账号",
                    "为公众号、知乎等平台创建独立账号空间。",
                    "accounts",
                  ],
                  [
                    "02",
                    "准备内容",
                    "保存文章、图文或视频，统一管理创作素材。",
                    "content",
                  ],
                  [
                    "03",
                    "编排发布计划",
                    "选择内容与账号，执行本地字段和素材预检。",
                    "tasks",
                  ],
                ].map(([number, title, text, target]) => (
                  <button
                    className="step"
                    key={number}
                    onClick={() => navigate(target as View)}
                  >
                    <span className="step-number">{number}</span>
                    <h3>{title}</h3>
                    <p>{text}</p>
                    <span className="step-link">前往设置 →</span>
                  </button>
                ))}
              </div>
              <div className="section-title">
                <h2>首批平台</h2>
                <span>公众号、知乎与小红书优先接入</span>
              </div>
              <div className="platform-grid">
                {platforms.map((p) => (
                  <div className="platform" key={p.id}>
                    <div className={`platform-avatar ${p.id}`}>{p.name[0]}</div>
                    <div>
                      <strong>{p.name}</strong>
                      <small>
                        {p.types.map((t) => typeNames[t]).join(" / ")}
                      </small>
                    </div>
                    <span className="tag">
                      {p.priority} ·{" "}
                      {p.readiness === "draft-spike"
                        ? "图文草稿验证通过"
                        : "待验证"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {view === "content" && (
            <div className="two-column">
              <section className="panel">
                <h2>
                  {editing ? "编辑内容（不会修改已有任务快照）" : "创建内容"}
                </h2>
                <form
                  key={editing?.id ?? "new"}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const values = new FormData(form);
                    void action(async () => {
                      const payload = {
                        type,
                        title: values.get("title"),
                        body: values.get("body"),
                        bodyFormat: values.get("bodyFormat") || "plain",
                        cover:
                          String(values.get("cover") ?? "").trim() || undefined,
                        summary: values.get("summary"),
                        author: values.get("author"),
                        images: String(values.get("images") ?? "")
                          .split("\n")
                          .map((v) => v.trim())
                          .filter(Boolean),
                        video:
                          String(values.get("video") ?? "").trim() || undefined,
                        tags: String(values.get("tags") ?? "")
                          .split(/[,，]/)
                          .map((v) => v.trim())
                          .filter(Boolean),
                      };
                      const content = editing
                        ? await rpc<Content>("content.update", {
                            id: editing.id,
                            content: payload,
                          })
                        : await rpc<Content>("content.create", payload);
                      setEditing(null);
                      setContentId(content.id);
                      setSelected([]);
                      form.reset();
                      setNotice("内容已保存到本地数据库");
                    });
                  }}
                >
                  <label>
                    内容类型
                    <select
                      value={type}
                      onChange={(e) => setType(e.target.value as ContentType)}
                    >
                      {Object.entries(typeNames).map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    标题
                    <input
                      name="title"
                      defaultValue={editing?.title ?? ""}
                      required
                      maxLength={500}
                      placeholder="给这篇内容起一个标题"
                    />
                  </label>
                  <label>
                    正文 / Markdown
                    <textarea
                      name="body"
                      defaultValue={editing?.body ?? ""}
                      rows={9}
                      required={type === "article"}
                      placeholder="从这里开始写作…"
                    />
                  </label>
                  {type === "article" && (
                    <label>
                      正文格式（公众号、知乎支持Markdown）
                      <select
                        name="bodyFormat"
                        defaultValue={editing?.bodyFormat ?? "plain"}
                      >
                        <option value="plain">纯文本</option>
                        <option value="markdown">Markdown</option>
                      </select>
                    </label>
                  )}
                  <div className="form-row">
                    <label>
                      作者
                      <input
                        name="author"
                        maxLength={100}
                        defaultValue={editing?.author ?? ""}
                      />
                    </label>
                    <label>
                      摘要
                      <input
                        name="summary"
                        maxLength={1000}
                        defaultValue={editing?.summary ?? ""}
                      />
                    </label>
                  </div>
                  <label>
                    标签 / 知乎话题（知乎最多5个，按名称精确匹配）
                    <input
                      name="tags"
                      placeholder="以逗号分隔"
                      defaultValue={editing?.tags.join(",") ?? ""}
                    />
                  </label>
                  {(type === "gallery" || type === "article") && (
                    <div className="asset-field">
                      <label>
                        正文图片（每行一张）
                        <textarea
                          name="images"
                          defaultValue={editing?.images.join("\n") ?? ""}
                          required={type === "gallery"}
                          rows={3}
                          placeholder="E:\\Pictures\\cover.jpg"
                        />
                      </label>
                      <label className="asset-picker">
                        <span>选择并托管正文图片</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                          multiple
                          disabled={busy}
                          onClick={(event) => {
                            if (
                              !(
                                window as unknown as {
                                  __TAURI_INTERNALS__?: unknown;
                                }
                              ).__TAURI_INTERNALS__
                            )
                              return;
                            event.preventDefault();
                            const form = event.currentTarget.form!;
                            void action(() =>
                              importPickedImages(form, "images"),
                            );
                          }}
                          onChange={(event) => {
                            const input = event.currentTarget;
                            const files = Array.from(input.files ?? []);
                            input.value = "";
                            const form = input.form!;
                            if (!files.length) return;
                            void action(async () =>
                              importPickedImages(
                                form,
                                "images",
                                await uploadImages(files),
                              ),
                            );
                          }}
                        />
                      </label>
                      <small>
                        选择图片后会上传至服务端素材库；也可填写服务端绝对路径。
                      </small>
                    </div>
                  )}
                  {type === "article" && (
                    <>
                      <small>
                        公众号正文图片按列表顺序追加文末；仅支持10MB以内PNG/JPEG。
                      </small>
                      <label>
                        封面图片绝对路径（可选）
                        <input
                          name="cover"
                          defaultValue={editing?.cover ?? ""}
                          placeholder="E:\\Pictures\\cover.png"
                        />
                      </label>
                      <label className="asset-picker">
                        <span>选择并托管封面图片</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                          disabled={busy}
                          onClick={(event) => {
                            if (
                              !(
                                window as unknown as {
                                  __TAURI_INTERNALS__?: unknown;
                                }
                              ).__TAURI_INTERNALS__
                            )
                              return;
                            event.preventDefault();
                            const form = event.currentTarget.form!;
                            void action(() =>
                              importPickedImages(form, "cover"),
                            );
                          }}
                          onChange={(event) => {
                            const input = event.currentTarget;
                            const files = Array.from(input.files ?? []);
                            input.value = "";
                            const form = input.form!;
                            if (!files.length) return;
                            void action(async () =>
                              importPickedImages(
                                form,
                                "cover",
                                await uploadImages(files),
                              ),
                            );
                          }}
                        />
                      </label>
                    </>
                  )}
                  {type === "video" && (
                    <label>
                      视频绝对路径
                      <input
                        name="video"
                        defaultValue={editing?.video ?? ""}
                        required
                        placeholder="E:\\Videos\\demo.mp4"
                      />
                    </label>
                  )}
                  {type !== "video" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(event) => {
                        const form = event.currentTarget.form!;
                        const images = form.elements.namedItem(
                          "images",
                        ) as HTMLTextAreaElement;
                        const cover = form.elements.namedItem(
                          "cover",
                        ) as HTMLInputElement | null;
                        const paths = images.value
                          .split("\n")
                          .map((p) => p.trim())
                          .filter(Boolean);
                        const hasCover = Boolean(cover?.value.trim());
                        void action(async () => {
                          if (!paths.length && !hasCover)
                            throw new Error("请先填写图片或封面的绝对路径");
                          const imported = await rpc<string[]>(
                            "assets.importImages",
                            {
                              paths: [
                                ...paths,
                                ...(hasCover ? [cover!.value.trim()] : []),
                              ],
                            },
                          );
                          images.value = imported
                            .slice(0, paths.length)
                            .join("\n");
                          if (hasCover) cover!.value = imported[paths.length];
                          setNotice(
                            "图片已复制到本地素材目录，原文件保留；请保存内容以记录新路径。",
                          );
                        });
                      }}
                    >
                      将图片复制到本地素材库
                    </button>
                  )}
                  <button className="primary" disabled={busy}>
                    保存内容
                  </button>
                  {editing && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      取消编辑
                    </button>
                  )}
                </form>
              </section>
              <section className="panel">
                <h2>
                  内容资产 <span className="count">{data.contents.length}</span>
                </h2>
                <div className="archive-options">
                  <div className="archive-option recommended">
                    <div>
                      <strong>便携归档（推荐跨机器迁移）</strong>
                      <small>
                        version 2 JSON
                        会内嵌正文图片和封面；不含账号、登录状态、任务或视频文件。
                      </small>
                    </div>
                    <button
                      className="primary"
                      disabled={busy || !data.contents.length}
                      onClick={() =>
                        void action(async () => {
                          if (isDesktopApp()) {
                            const path =
                              await choosePortableArchiveDestination();
                            if (!path) return;
                            const result = await rpc<{ size: number }>(
                              "content.exportPortableFile",
                              {
                                path,
                                ids: data.contents.map((content) => content.id),
                              },
                            );
                            setNotice(
                              `便携归档已保存（${Math.ceil(result.size / 1024)}KB）；包含图片，不含账号、任务和登录信息。`,
                            );
                            return;
                          }
                          const archive = await rpc<unknown>(
                            "content.exportPortable",
                            { ids: data.contents.map((content) => content.id) },
                          );
                          const blob = new Blob(
                            [JSON.stringify(archive, null, 2)],
                            { type: "application/json" },
                          );
                          if (blob.size > 70 * 1024 * 1024)
                            throw new Error("归档超过70MB限制");
                          const url = URL.createObjectURL(blob);
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = "turbopush-portable-v2.json";
                          link.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                          setNotice(
                            "便携归档已生成；包含图片，不含账号、任务和登录信息。",
                          );
                        })
                      }
                    >
                      下载便携归档
                    </button>
                    <label className="archive-import">
                      选择并导入便携归档
                      <input
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        onClick={(event) => {
                          if (!isDesktopApp()) return;
                          event.preventDefault();
                          void action(async () => {
                            const path = await pickPortableArchive();
                            if (!path) return;
                            const imported = await rpc<Content[]>(
                              "content.importPortableFile",
                              { path },
                            );
                            setNotice(
                              `已导入${imported.length}篇内容并重建图片素材；未导入账号、任务或登录信息。`,
                            );
                          });
                        }}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (!file) return;
                          void action(async () => {
                            if (file.size > 70 * 1024 * 1024)
                              throw new Error("归档超过70MB限制");
                            const archive = JSON.parse(await file.text()) as {
                              version?: unknown;
                            };
                            if (archive.version !== 2)
                              throw new Error(
                                "这不是version 2便携归档，请使用下方旧JSON导入入口",
                              );
                            const imported = await rpc<Content[]>(
                              "content.import",
                              archive,
                            );
                            setNotice(
                              `已导入${imported.length}篇内容并重建图片素材；未导入账号、任务或登录信息。`,
                            );
                          });
                        }}
                      />
                    </label>
                    <p className="archive-warning">
                      安全限制：只接受应用生成的version 2
                      JSON；导入会校验图片哈希、真实格式、单图10MB与总包50MB，任一项失败则整批不导入。请勿导入来源不明的文件。
                    </p>
                    {!isDesktopApp() && (
                      <p className="archive-warning">
                        Web端支持图片上传及最大70MB的便携归档导入和下载。
                      </p>
                    )}
                  </div>
                  <div className="archive-option legacy">
                    <strong>旧内容 JSON（仅本机路径）</strong>
                    <button
                      disabled={busy || !data.contents.length}
                      onClick={() => {
                        const contents = data.contents.map(
                          ({ id, createdAt, ...content }) => content,
                        );
                        const archive = new Blob(
                          [JSON.stringify({ version: 1, contents }, null, 2)],
                          { type: "application/json" },
                        );
                        if (contents.length > 100 || archive.size > 900000) {
                          setError(
                            "当前导入导出最多100篇、900KB，内容过多请先分批整理",
                          );
                          return;
                        }
                        const url = URL.createObjectURL(archive);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = "turbopush-contents.json";
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      导出旧内容 JSON
                    </button>
                    <label>
                      导入旧内容 JSON（最多100篇、文件小于900KB）
                      <input
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (!file) return;
                          void action(async () => {
                            if (file.size > 900000)
                              throw new Error("导入文件超过900KB限制");
                            const imported = await rpc<Content[]>(
                              "content.import",
                              JSON.parse(await file.text()),
                            );
                            setNotice(
                              `已导入${imported.length}篇内容，未创建任务或发布`,
                            );
                          });
                        }}
                      />
                    </label>
                    <small>
                      只导入导出内容，不含账号、登录状态或任务；图片与视频仅记录路径，换机器需另行复制素材。
                    </small>
                  </div>
                </div>
                {!data.contents.length && (
                  <Empty text="还没有内容。先保存第一篇文章。" />
                )}
                {data.contents.map((c) => (
                  <article className="content-card" key={c.id}>
                    <span className="tag">{typeNames[c.type]}</span>
                    <h3>{c.title}</h3>
                    <p>{c.body.slice(0, 150) || c.video}</p>
                    <small>{new Date(c.createdAt).toLocaleString()}</small>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(c);
                        setType(c.type);
                      }}
                    >
                      编辑内容
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setContentId(c.id);
                        setSelected([]);
                        navigate("tasks");
                      }}
                    >
                      创建发布计划 →
                    </button>
                  </article>
                ))}
              </section>
            </div>
          )}
          {view === "accounts" && (
            <>
              <section className="panel">
                <h2>添加平台账号</h2>
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const name = new FormData(form).get("name");
                    void action(async () => {
                      await rpc("account.create", {
                        platform: accountPlatform,
                        name,
                      });
                      form.reset();
                      setNotice("账号已创建，可打开隔离浏览器登录");
                    });
                  }}
                >
                  <label>
                    平台
                    <select
                      value={accountPlatform}
                      onChange={(e) =>
                        setAccountPlatform(e.target.value as PlatformId)
                      }
                    >
                      {platforms.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    账号备注
                    <input
                      name="name"
                      required
                      maxLength={80}
                      placeholder="例如：我的公众号"
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    添加账号
                  </button>
                </form>
              </section>
              <section className="panel">
                <h2>账号列表</h2>
                {!data.accounts.length && (
                  <Empty text="添加账号后，可打开独立浏览器进行扫码登录。" />
                )}
                {data.accounts.map((account) => {
                  const a = account as AccountLoginView;
                  const needsLogin = [
                    "expired",
                    "intervention_required",
                  ].includes(a.loginStatus);
                  return (
                    <div
                      className={`account-row login-${a.loginStatus}`}
                      key={a.id}
                    >
                      <div className={`platform-avatar ${a.platform}`}>
                        {platformName(a.platform)[0]}
                      </div>
                      <div className="grow">
                        <strong>{a.name}</strong>
                        <small>{platformName(a.platform)}</small>
                        <div className="login-state">
                          <span className={`login-badge ${a.loginStatus}`}>
                            {loginStatusNames[a.loginStatus]}
                          </span>
                          {a.checkedAt && (
                            <time dateTime={a.checkedAt}>
                              最近检查：
                              {new Date(a.checkedAt).toLocaleString()}
                            </time>
                          )}
                        </div>
                        {a.message && (
                          <p className="login-message">{a.message}</p>
                        )}
                      </div>
                      <button
                        disabled={busy || a.loginStatus === "checking"}
                        onClick={() =>
                          void action(async () => {
                            await rpc("account.checkLogin", { id: a.id });
                            setNotice("登录状态检查完成");
                          })
                        }
                      >
                        {a.loginStatus === "checking"
                          ? "正在检查"
                          : "检查登录状态"}
                      </button>
                      <button
                        className={needsLogin ? "reauth" : undefined}
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const r = await rpc<{ message: string }>(
                              "account.open",
                              { id: a.id },
                            );
                            setNotice(r.message);
                          })
                        }
                      >
                        {needsLogin
                          ? "打开登录窗口 / 重新认证"
                          : "打开登录窗口"}
                      </button>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await rpc("account.close", { id: a.id });
                            setNotice("已关闭浏览器");
                          })
                        }
                      >
                        关闭窗口
                      </button>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const r = await rpc<{ file: string }>(
                              "diagnostics.capture",
                              { id: a.id },
                            );
                            setNotice(`本地诊断截图：${r.file}`);
                          })
                        }
                      >
                        截图
                      </button>
                    </div>
                  );
                })}
              </section>
            </>
          )}
          {view === "tasks" && (
            <>
              <section className="panel">
                <h2>编排发布计划</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await rpc("campaign.create", {
                        contentId,
                        accountIds: selected,
                        scheduledAt: scheduledAt
                          ? new Date(scheduledAt).toISOString()
                          : undefined,
                      });
                      setSelected([]);
                      setNotice("本地任务已保存，尚未启用自动发布");
                    });
                  }}
                >
                  <div className="form-row">
                    <label>
                      选择内容
                      <select
                        required
                        value={contentId}
                        onChange={(e) => {
                          setContentId(e.target.value);
                          setSelected([]);
                        }}
                      >
                        <option value="">请选择已保存的内容</option>
                        {data.contents.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      草稿队列执行时间
                      <input
                        type="datetime-local"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>选择兼容账号</label>
                  <div className="account-options">
                    {compatible.map((a) => (
                      <label className="check" key={a.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(a.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, a.id]
                                : selected.filter((id) => id !== a.id),
                            )
                          }
                        />
                        {a.name} <small>{platformName(a.platform)}</small>
                      </label>
                    ))}
                    {!compatible.length && (
                      <p className="muted">
                        选择内容后显示兼容账号；请先添加对应平台账号。
                      </p>
                    )}
                  </div>
                  <button
                    className="primary"
                    disabled={
                      busy || !selected.length || hasUnsupportedSchedule
                    }
                    title={
                      hasUnsupportedSchedule
                        ? "所选平台尚未开放草稿队列；请清空执行时间并创建待处理任务"
                        : undefined
                    }
                  >
                    {scheduledAt ? "加入草稿队列" : "创建待处理任务"}
                  </button>
                  {hasUnsupportedSchedule && (
                    <p className="muted" role="status">
                      所选内容类型尚未开放草稿队列；可清空执行时间，先创建待处理任务并执行本地预检。
                    </p>
                  )}
                </form>
              </section>
              <QueueSummary tasks={data.tasks} />
              <section className="panel">
                <h2>
                  任务记录 <span className="count">{data.tasks.length}</span>
                </h2>
                {!data.tasks.length && (
                  <Empty text="还没有任务。选择一份内容和目标账号开始。" />
                )}
                {data.tasks.map((task) => {
                  const t = task as QueueTask;
                  const capability = taskCapability(t.platform, t.content.type);
                  const queueStage =
                    t.status === "scheduled"
                      ? "queued"
                      : t.status === "validating"
                        ? "validating"
                        : t.status === "publishing"
                          ? "publishing"
                          : null;
                  return (
                    <article className="task" key={t.id}>
                      <div className="task-top">
                        <strong>{t.content.title}</strong>
                        <span className="tag">{stateNames[t.status]}</span>
                      </div>
                      <small>
                        {platformName(t.platform)} ·{" "}
                        {data.accounts.find((a) => a.id === t.accountId)?.name}
                        {t.scheduledAt
                          ? ` · ${new Date(t.scheduledAt).toLocaleString()}`
                          : ""}
                      </small>
                      <p>{t.message}</p>
                      {queueStage && (
                        <div
                          className={`task-progress ${queueStage}`}
                          role="progressbar"
                          aria-label="草稿队列进度"
                          aria-valuetext={queueStage}
                        >
                          <span />
                          <small>
                            {queueStage === "queued"
                              ? "queued · 正在等待草稿队列调度"
                              : queueStage === "validating"
                                ? "validating · 正在检查内容与本地素材…"
                                : "publishing · 正在保存平台草稿，请勿重复操作…"}
                          </small>
                        </div>
                      )}
                      {(t.attemptCount !== undefined || t.nextRunAt) && (
                        <dl className="retry-meta" aria-label="队列重试信息">
                          {t.attemptCount !== undefined && (
                            <div>
                              <dt>尝试次数</dt>
                              <dd>{t.attemptCount}</dd>
                            </div>
                          )}
                          {t.nextRunAt && (
                            <div>
                              <dt>下次重试</dt>
                              <dd>{new Date(t.nextRunAt).toLocaleString()}</dd>
                            </div>
                          )}
                        </dl>
                      )}
                      {t.status === "scheduled" && t.scheduledAt && (
                        <p className="queue-detail">
                          已加入草稿队列，将在{" "}
                          {new Date(t.scheduledAt).toLocaleString()}{" "}
                          后尝试执行；只保存草稿，不公开发布。
                        </p>
                      )}
                      {["failed", "intervention_required"].includes(
                        t.status,
                      ) && (
                        <p className="retry-detail">
                          自动重试已暂停。请先确认平台草稿状态，再决定重试或取消，避免重复保存。
                        </p>
                      )}
                      <div className="task-actions">
                        {[
                          "pending",
                          "scheduled",
                          "failed",
                          "intervention_required",
                        ].includes(t.status) && (
                          <>
                            <button
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await rpc("task.preflight", { id: t.id });
                                  setNotice("本地预检完成，未执行平台发布");
                                })
                              }
                            >
                              本地预检
                            </button>
                            {capability.saveDraft &&
                              t.status !== "scheduled" && (
                                <button
                                  className="primary"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(async () => {
                                      setNotice(
                                        "正在保存草稿并远端核对，请勿在编辑器中手动修改…",
                                      );
                                      await rpc("task.saveDraft", { id: t.id });
                                      setNotice(
                                        "草稿保存并回读成功，未公开发布",
                                      );
                                    })
                                  }
                                >
                                  保存
                                  {platformName(t.platform)}
                                  草稿
                                </button>
                              )}
                            {t.status === "pending" &&
                              capability.enqueueDraft && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  title="加入本地队列，只保存平台草稿，不会公开发布"
                                  onClick={() =>
                                    void action(async () => {
                                      await rpc("task.enqueueDraft", {
                                        id: t.id,
                                      });
                                      setNotice(
                                        "已加入草稿队列；到期后只保存草稿，不公开发布。",
                                      );
                                    })
                                  }
                                >
                                  加入草稿队列
                                </button>
                              )}
                            <button
                              className="quiet"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await rpc("task.cancel", { id: t.id });
                                })
                              }
                            >
                              取消任务
                            </button>
                          </>
                        )}
                        {(t.status === "pending" ||
                          (t.status === "intervention_required" &&
                            t.message ===
                              "待发表编辑器会话已中断；未自动发表，请人工核对")) &&
                          t.platform === "xiaohongshu" &&
                          t.content.type === "gallery" && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  if (
                                    !window.confirm(
                                      `为小红书账号准备「${t.content.title}」的图文编辑器并上传图片？此步不会公开发布。`,
                                    )
                                  )
                                    return;
                                  await rpc("task.preparePublish", {
                                    ...(t.status === "intervention_required"
                                      ? { restore: true }
                                      : {}),
                                    id: t.id,
                                    accountId: t.accountId,
                                    title: t.content.title,
                                    confirmed: true,
                                  });
                                  setNotice(
                                    "小红书编辑器已准备，待逐图核对后确认公开发布",
                                  );
                                })
                              }
                            >
                              准备小红书发布（实验）
                            </button>
                          )}
                        {((t.status === "draft_saved" &&
                          ["zhihu", "wechat-official"].includes(t.platform)) ||
                          (t.status === "publication_ready" &&
                            t.platform === "xiaohongshu")) && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              const account = data.accounts.find(
                                (account) => account.id === t.accountId,
                              );
                              const title = window.prompt(
                                `实验功能：将向${platformName(t.platform)}账号「${account?.name ?? t.accountId}」公开发布内容「${t.content.title}」。请核对正文和图片，输入完整标题确认。真实账号发布验收尚未完成。`,
                              );
                              if (title !== t.content.title) return;
                              void action(async () => {
                                await rpc("task.publish", {
                                  id: t.id,
                                  accountId: t.accountId,
                                  title,
                                  confirmed: true,
                                });
                                setNotice("已公开发布并完成发布页刷新回读");
                              });
                            }}
                          >
                            公开发布（实验）
                          </button>
                        )}
                        {t.status === "intervention_required" &&
                          (t.message?.includes("已提交公开发布") ||
                            t.message?.startsWith("公开结果链接待回读：")) && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await rpc("task.verifyPublication", {
                                    id: t.id,
                                    accountId: t.accountId,
                                  });
                                  setNotice("已只读核对公开页，未重复发表");
                                })
                              }
                            >
                              只读核对发布结果
                            </button>
                          )}
                        {t.status === "intervention_required" &&
                          t.message?.startsWith("公开结果链接待回读：") && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `仅在你已打开平台公开页，并确认「${t.content.title}」的正文和全部图片内容、顺序正确后点击确定。此项记录人工核对结果，不代表自动回读通过。`,
                                  )
                                )
                                  return;
                                void action(async () => {
                                  await rpc("task.confirmPublicationReview", {
                                    id: t.id,
                                    accountId: t.accountId,
                                    title: t.content.title,
                                    confirmed: true,
                                  });
                                  setNotice("已记录人工核对完成，未重复发表");
                                });
                              }}
                            >
                              记录人工核对完成
                            </button>
                          )}
                        {t.status === "succeeded" && t.resultUrl && (
                          <a
                            href={t.resultUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看发布结果
                          </a>
                        )}
                        {t.resultUrl && t.status !== "succeeded" && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                await rpc("task.openDraft", { id: t.id });
                                setNotice("草稿已在账号浏览器中打开");
                              })
                            }
                          >
                            查看已有草稿
                          </button>
                        )}
                        <button
                          type="button"
                          className="quiet"
                          aria-expanded={timelineTaskId === t.id}
                          aria-controls={`task-events-${t.id}`}
                          onClick={() => {
                            const opening = timelineTaskId !== t.id;
                            setTimelineTaskId(opening ? t.id : null);
                            setTimelineEvents([]);
                            setTimelineError("");
                          }}
                        >
                          {timelineTaskId === t.id
                            ? "收起事件记录"
                            : "查看事件记录"}
                        </button>
                      </div>
                      {timelineTaskId === t.id && (
                        <TaskTimeline
                          id={`task-events-${t.id}`}
                          events={timelineEvents}
                          loading={timelineLoading}
                          error={timelineError}
                        />
                      )}
                    </article>
                  );
                })}
              </section>
            </>
          )}
          <footer>本地存储 · 独立账号空间 · 发布进度可追溯</footer>
        </div>
      </main>
    </div>
  );
}
function QueueSummary({ tasks }: { tasks: Snapshot["tasks"] }) {
  const summary = queueSummary(tasks);
  const metrics = [
    ["等待调度", summary.waiting, "计划执行或等待重试"],
    ["执行中", summary.active, "本地预检或草稿保存"],
    ["需处理", summary.attention, "失败或需要人工确认"],
    ["草稿完成", summary.completed, "保存并回读完成"],
  ] as const;
  return (
    <section className="queue-summary" aria-label="草稿队列汇总">
      {metrics.map(([label, count, description]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{count}</strong>
          <small>{description}</small>
        </div>
      ))}
    </section>
  );
}
function TaskTimeline({
  id,
  events,
  loading,
  error,
}: {
  id: string;
  events: TaskEvent[];
  loading: boolean;
  error: string;
}) {
  return (
    <section className="task-timeline" id={id} aria-label="任务事件时间线">
      <div className="timeline-heading">
        <strong>事件记录</strong>
        <small>展开期间每 2 秒自动刷新</small>
      </div>
      {loading && !events.length && <p role="status">正在读取事件…</p>}
      {error && (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !events.length && <p>暂无事件记录。</p>}
      {!!events.length && (
        <ol>
          {events.map((event) => (
            <li key={event.id} className={`event-${event.status}`}>
              <div>
                <span className="tag">{stateNames[event.status]}</span>
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </div>
              <p>{event.message || "状态已更新"}</p>
              {event.progressStage && (
                <small className="event-progress">
                  {progressStageNames[event.progressStage]}
                  {event.progressCurrent !== null &&
                  event.progressTotal !== null
                    ? ` · ${event.progressCurrent} / ${event.progressTotal}`
                    : ""}
                </small>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <div>▤</div>
      <p>{text}</p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
