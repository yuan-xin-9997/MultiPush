'use strict'

const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  net,
  Notification,
  screen,
  session,
  shell,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const APP_ID = 'top.yuan-xin.multipush'
const GITHUB_REPO = 'yuan-xin-9997/MultiPush'
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`
const SETTINGS_FILE = 'desktop-settings.json'
const PREFERRED_PORT = 34180
const FALLBACK_PORTS = [34181, 34182, 34183]
const isMac = process.platform === 'darwin'

app.setName('MultiPush')
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
if (process.env.MULTIPUSH_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.MULTIPUSH_USER_DATA))
}

let mainWindow = null
let service = null
let starting = false
let quitting = false
let appUrl = null
let settings = null
let saveBoundsTimer = null
let failureDialogOpen = false

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(start).catch(handleFatalError)

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      return
    }
    createMainWindow()
    if (appUrl) {
      void mainWindow.loadURL(appUrl).catch((error) => showLocalFailure(error))
    } else {
      void startLocalService().catch((error) => showLocalFailure(error))
    }
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', (event) => {
    saveWindowState()
    if (quitting || !service) {
      quitting = true
      return
    }
    event.preventDefault()
    quitting = true
    log('正在关闭本地服务…')
    const forceTimer = setTimeout(() => {
      log('本地服务关闭超时，强制退出')
      app.exit(0)
    }, 12_000)
    forceTimer.unref()
    service.close()
      .catch((error) => log(`关闭本地服务失败：${error instanceof Error ? error.message : error}`))
      .finally(() => {
        clearTimeout(forceTimer)
        service = null
        app.quit()
      })
  })
}

function handleFatalError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  log(`启动失败：${message}`)
  dialog.showErrorBox('MultiPush 启动失败', `${message}\n\n数据目录：${dataDirectory()}\n日志：${logFile()}`)
  app.quit()
}

async function start() {
  settings = readSettings()
  cleanupLog()
  app.setAboutPanelOptions({
    applicationName: 'MultiPush',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: 'Copyright © 2026 yuan.xin',
    credits: '多平台智能发布系统 · 本地桌面版',
  })
  configureSession()
  createMenu()
  createMainWindow()
  try {
    await startLocalService()
  } catch (error) {
    showLocalFailure(error)
  }
}

function settingsFile() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

function readSettings() {
  const fallback = { window: null, port: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    const port = Number.parseInt(String(parsed.port ?? ''), 10)
    return {
      window: sanitizeBounds(parsed.window),
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null,
    }
  } catch {
    return fallback
  }
}

function writeSettings() {
  if (!settings) return
  try {
    const file = settingsFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    log(`无法保存桌面设置：${error instanceof Error ? error.message : error}`)
  }
}

function dataDirectory() {
  return path.join(app.getPath('userData'), 'data')
}

function logFile() {
  return path.join(app.getPath('userData'), 'logs', 'multipush.log')
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.appendFileSync(logFile(), `${line}\n`, 'utf8')
  } catch {
    // Logging must never prevent the app from starting.
  }
  if (!app.isPackaged) console.log(`[multipush] ${message}`)
}

function cleanupLog() {
  try {
    const file = logFile()
    if (fs.statSync(file).size > 5 * 1024 * 1024) {
      fs.renameSync(file, `${file}.old`)
    }
  } catch {
    // The log does not exist yet.
  }
}

function sanitizeBounds(value) {
  if (!value || typeof value !== 'object') return null
  const { x, y, width, height, maximized } = value
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  if (width < 900 || height < 620) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: maximized === true,
  }
}

function restoreBounds() {
  const fallback = { width: 1440, height: 940 }
  const saved = settings?.window
  if (!saved) return fallback
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return saved.x < area.x + area.width
      && saved.x + saved.width > area.x
      && saved.y < area.y + area.height
      && saved.y + saved.height > area.y
  })
  if (!visible) return fallback
  return { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const bounds = restoreBounds()
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1024,
    minHeight: 680,
    title: 'MultiPush',
    backgroundColor: '#f7f8fa',
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      void mainWindow.loadURL(url).catch((error) => showLocalFailure(error))
    } else {
      openExternal(url)
    }
    return { action: 'deny' }
  })

  const guardNavigation = (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow.isVisible()) mainWindow.show()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (!validatedURL.startsWith('http://') && !validatedURL.startsWith('https://')) return
    showLocalFailure(new Error(`${errorDescription || `错误 ${errorCode}`}（${validatedURL}）`))
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程退出：${details.reason}`)
    showLocalFailure(new Error(`界面进程异常退出：${details.reason}`))
  })

  mainWindow.on('resize', scheduleSaveBounds)
  mainWindow.on('move', scheduleSaveBounds)
  mainWindow.on('maximize', scheduleSaveBounds)
  mainWindow.on('unmaximize', scheduleSaveBounds)
  mainWindow.on('close', saveWindowState)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  void mainWindow.loadFile(path.join(__dirname, 'loading.html')).catch(() => {})
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
  })
  if (settings?.window?.maximized) mainWindow.maximize()
  return mainWindow
}

function scheduleSaveBounds() {
  clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(saveWindowState, 500)
}

function saveWindowState() {
  clearTimeout(saveBoundsTimer)
  if (!settings || !mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getNormalBounds()
  settings.window = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
  }
  writeSettings()
}

function startPorts() {
  const ports = [settings?.port, PREFERRED_PORT, ...FALLBACK_PORTS, 0]
    .filter((port) => Number.isInteger(port) && port >= 0 && port <= 65535)
  return [...new Set(ports)]
}

async function startLocalService() {
  if (starting || service) return
  starting = true
  try {
    const serverEntry = path.join(__dirname, 'server', 'index.cjs')
    if (!fs.existsSync(serverEntry)) {
      throw new Error('缺少本地服务文件 desktop/server/index.cjs，请重新安装客户端。')
    }
    const webDist = app.isPackaged
      ? path.join(process.resourcesPath, 'web')
      : path.join(__dirname, 'web-dist')
    if (!fs.existsSync(path.join(webDist, 'index.html'))) {
      throw new Error(`缺少前端构建产物 ${webDist}，请重新安装客户端。`)
    }
    const { startMultiPushServer } = require(serverEntry)
    if (typeof startMultiPushServer !== 'function') {
      throw new Error('本地服务入口无效，请重新安装客户端。')
    }

    let lastError = null
    for (const port of startPorts()) {
      try {
        service = await startMultiPushServer({
          host: '127.0.0.1',
          port,
          nodeEnv: 'production',
          dataDir: dataDirectory(),
          webDist,
          desktopMode: true,
        })
        break
      } catch (error) {
        lastError = error
        if (error && error.code === 'EADDRINUSE' && port !== 0) {
          log(`本地端口 ${port} 已被占用，尝试下一个端口`)
          continue
        }
        throw error
      }
    }
    if (!service) throw lastError || new Error('无法启动本地服务')
    appUrl = service.url
    const actualPort = Number.parseInt(new URL(appUrl).port, 10)
    if (Number.isInteger(actualPort)) {
      settings.port = actualPort
      writeSettings()
    }
    log(`本地服务已启动：${appUrl}`)
    log(`数据目录：${dataDirectory()}`)

    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
    await mainWindow.loadURL(appUrl)
    if (!mainWindow.isVisible()) mainWindow.show()
  } finally {
    starting = false
  }
}

async function restartLocalService() {
  if (starting || failureDialogOpen) return
  try {
    if (service) {
      const old = service
      service = null
      await old.close()
    }
    appUrl = null
    await startLocalService()
  } catch (error) {
    showLocalFailure(error)
  }
}

function showLocalFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  log(`本地服务异常：${message}`)
  if (failureDialogOpen) return
  failureDialogOpen = true
  void dialog.showMessageBox({
    type: 'error',
    title: 'MultiPush 本地服务异常',
    message: '无法连接本地服务',
    detail: `${message}\n\n数据目录：${dataDirectory()}\n日志：${logFile()}`,
    buttons: ['重启本地服务', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then(async (result) => {
    failureDialogOpen = false
    if (result.response === 0) await restartLocalService()
    else {
      quitting = true
      app.quit()
    }
  })
}

function isAppUrl(target) {
  if (!appUrl) return false
  try {
    return new URL(target).origin === new URL(appUrl).origin
  } catch {
    return false
  }
}

function openExternal(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return
    void shell.openExternal(url.href)
  } catch {
    // Ignore malformed or unsupported URLs.
  }
}

function configureSession() {
  const allowedPermissions = new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
    'fullscreen',
  ])
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents.getURL()
    callback(allowedPermissions.has(permission) && isAppUrl(requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return allowedPermissions.has(permission) && isAppUrl(requestingOrigin)
  })
  session.defaultSession.on('will-download', handleDownload)
}

function handleDownload(_event, item) {
  const filename = safeFilename(item.getFilename())
  const target = uniqueDownloadPath(filename)
  item.setSavePath(target)
  item.once('done', (_doneEvent, state) => {
    if (state === 'completed') notifyDownload('下载完成', filename, target)
    else if (state === 'interrupted') notifyDownload('下载中断', filename, target)
  })
}

function safeFilename(value) {
  let name = typeof value === 'string' ? value : ''
  try {
    name = decodeURIComponent(name)
  } catch {
    // Keep the original name when it is not URI encoded.
  }
  name = path.basename(name)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    name = 'multipush-download'
  }
  return name.slice(0, 180)
}

function uniqueDownloadPath(filename) {
  const directory = app.getPath('downloads')
  fs.mkdirSync(directory, { recursive: true })
  const extension = path.extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  let candidate = path.join(directory, filename)
  let counter = 1
  while (fs.existsSync(candidate) && counter < 1000) {
    candidate = path.join(directory, `${stem} (${counter})${extension}`)
    counter += 1
  }
  return candidate
}

function notifyDownload(title, filename, target) {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body: filename })
  notification.on('click', () => shell.showItemInFolder(target))
  notification.show()
}

function createMenu() {
  const template = []
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 MultiPush' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 MultiPush' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 MultiPush' },
      ],
    })
  }

  template.push({
    label: '本地服务',
    submenu: [
      {
        label: '重启本地服务',
        click: () => void restartLocalService(),
      },
      {
        label: '在浏览器中打开',
        enabled: Boolean(appUrl),
        click: () => {
          if (appUrl) void shell.openExternal(appUrl)
        },
      },
      {
        label: '复制本地地址',
        enabled: Boolean(appUrl),
        click: () => {
          if (appUrl) clipboard.writeText(appUrl)
        },
      },
      { type: 'separator' },
      {
        label: '打开数据目录',
        click: () => {
          fs.mkdirSync(dataDirectory(), { recursive: true })
          void shell.openPath(dataDirectory())
        },
      },
      {
        label: '打开日志文件',
        click: () => {
          fs.mkdirSync(path.dirname(logFile()), { recursive: true })
          if (!fs.existsSync(logFile())) fs.writeFileSync(logFile(), '', 'utf8')
          void shell.openPath(logFile())
        },
      },
      { type: 'separator' },
      {
        label: '检查更新…',
        click: () => void checkForUpdates(true),
      },
      ...(!isMac ? [
        { type: 'separator' },
        { role: 'quit', label: '退出 MultiPush' },
      ] : []),
    ],
  })

  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'selectAll', label: '全选' },
    ],
  })

  template.push({
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载页面' },
      { role: 'forceReload', label: '强制重新加载' },
      {
        label: '开发者工具',
        accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
        click: () => {
          const target = BrowserWindow.getFocusedWindow()
          if (target) target.webContents.toggleDevTools()
        },
      },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '切换全屏' },
    ],
  })

  template.push({
    label: '窗口',
    submenu: [
      { role: 'minimize', label: '最小化' },
      ...(isMac
        ? [{ role: 'zoom', label: '缩放' }, { role: 'front', label: '全部置于顶层' }]
        : [{ role: 'close', label: '关闭' }]),
    ],
  })

  template.push({
    label: '帮助',
    submenu: [
      { label: '使用说明', click: () => void shell.openExternal(`https://github.com/${GITHUB_REPO}/blob/main/docs/USER_GUIDE.md`) },
      { label: '问题反馈', click: () => void shell.openExternal(`https://github.com/${GITHUB_REPO}/issues`) },
      ...(!isMac ? [
        { type: 'separator' },
        { label: '关于 MultiPush', click: () => void showAbout() },
      ] : []),
    ],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function showAbout() {
  const detail = [
    `版本 ${app.getVersion()}`,
    `本地地址 ${appUrl || '未启动'}`,
    `数据目录 ${dataDirectory()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    '',
    '完全本地运行：内容、账号和发布记录保存在这台电脑。',
  ].join('\n')
  void showMessageBox({
    type: 'info',
    title: '关于 MultiPush',
    message: 'MultiPush 本地桌面版',
    detail,
    buttons: ['确定'],
    noLink: true,
  })
}

function showMessageBox(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
}

async function checkForUpdates(interactive) {
  try {
    const response = await net.fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MultiPushDesktop/${app.getVersion()}`,
      },
    })
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
    const release = await response.json()
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const latest = tag.replace(/^v/i, '')
    if (!latest) throw new Error('没有可用的版本信息')
    if (compareVersions(latest, app.getVersion()) > 0) {
      const result = await showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `发现新版本 ${tag}`,
        detail: `当前版本 ${app.getVersion()}。是否打开 GitHub Releases 下载页面？`,
        buttons: ['下载新版本', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (result.response === 0) {
        const target = typeof release.html_url === 'string' ? release.html_url : RELEASES_URL
        await shell.openExternal(target)
      }
      return
    }
    if (interactive) {
      await showMessageBox({
        type: 'info',
        title: '检查更新',
        message: '已是最新版本',
        detail: `当前版本 ${app.getVersion()}`,
        buttons: ['确定'],
        noLink: true,
      })
    }
  } catch (error) {
    if (!interactive) return
    await showMessageBox({
      type: 'warning',
      title: '检查更新',
      message: '无法检查更新',
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['确定'],
      noLink: true,
    })
  }
}

function compareVersions(left, right) {
  const parse = (value) => String(value)
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

process.on('uncaughtException', (error) => {
  log(`未捕获异常：${error.stack || error.message}`)
})
process.on('unhandledRejection', (reason) => {
  log(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack || reason.message : String(reason)}`)
})
