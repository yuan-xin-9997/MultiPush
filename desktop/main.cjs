'use strict'

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  net,
  Notification,
  screen,
  session,
  shell,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_SERVER = 'https://publish.yuan-xin.top'
const APP_ID = 'top.yuan-xin.multipush'
const GITHUB_REPO = 'yuan-xin-9997/MultiPush'
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`
const SETTINGS_FILE = 'desktop-settings.json'
const isMac = process.platform === 'darwin'

app.setName('MultiPush')
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
if (process.env.MULTIPUSH_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.MULTIPUSH_USER_DATA))
}

let mainWindow = null
let setupWindow = null
let settings = null
let connectionUrl = null
let connectionReady = false
let failureShownFor = null
let quitting = false
let saveBoundsTimer = null

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const target = setupWindow || mainWindow
    if (!target || target.isDestroyed()) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
  })

  app.whenReady().then(start).catch(handleFatalError)

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      return
    }
    createMainWindow()
    if (settings.serverUrl) void loadApp(settings.serverUrl)
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    saveWindowBounds()
  })
}

function handleFatalError(error) {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('MultiPush 启动失败', message)
  app.quit()
}

async function start() {
  settings = readSettings()
  app.setAboutPanelOptions({
    applicationName: 'MultiPush',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: 'Copyright © 2026 yuan.xin',
    credits: '多平台智能发布系统桌面客户端',
  })
  registerIpc()
  configureSession()
  createMenu()
  createMainWindow()

  const forceSetup = process.argv.includes('--setup')
  const smoke = process.env.MULTIPUSH_SMOKE === '1'
  if (!smoke && !forceSetup && settings.configured) {
    void loadApp(settings.serverUrl)
  } else {
    openSetupWindow('first-run')
  }
}

function settingsFile() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

function fallbackServer() {
  const fromEnv = process.env.MULTIPUSH_SERVER
  if (fromEnv) {
    try {
      return normalizeServer(fromEnv)
    } catch {
      // Ignore an invalid development override and use the public service.
    }
  }
  return DEFAULT_SERVER
}

function readSettings() {
  const fallback = { serverUrl: fallbackServer(), window: null, configured: false }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    const serverUrl = typeof parsed.serverUrl === 'string'
      ? normalizeServer(parsed.serverUrl)
      : fallback.serverUrl
    return {
      serverUrl,
      window: sanitizeBounds(parsed.window),
      configured: true,
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
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        serverUrl: settings.serverUrl,
        window: settings.window,
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  } catch (error) {
    console.error('[multipush] 无法保存桌面设置:', error)
  }
}

function normalizeServer(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('请输入服务器地址')
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('地址格式不正确，例如 https://publish.yuan-xin.top')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 HTTP 或 HTTPS 地址')
  }
  if (url.username || url.password) {
    throw new Error('地址中不能包含用户名或密码')
  }
  let pathname = url.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/api\/health$/i, '')
  return `${url.origin}${pathname}`
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
      mainWindow.loadURL(url).catch(() => {})
    } else {
      openExternal(url)
    }
    return { action: 'deny' }
  })

  const guardNavigation = (event, url) => {
    if (isAppUrl(url) || isHttpsUpgrade(url)) return
    event.preventDefault()
    openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  mainWindow.webContents.on('did-navigate', (_event, loadedUrl) => {
    upgradeConnectionUrl(loadedUrl)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const loaded = mainWindow.webContents.getURL()
    if (!loaded.startsWith('http://') && !loaded.startsWith('https://')) return
    upgradeConnectionUrl(loaded)
    connectionReady = true
    failureShownFor = null
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close()
    if (!mainWindow.isVisible()) mainWindow.show()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (!validatedURL.startsWith('http://') && !validatedURL.startsWith('https://')) return
    connectionReady = false
    showConnectionFailure(`无法连接到 ${connectionUrl || validatedURL}（${errorDescription || `错误 ${errorCode}`}）`)
  })

  mainWindow.on('resize', scheduleSaveBounds)
  mainWindow.on('move', scheduleSaveBounds)
  mainWindow.on('maximize', scheduleSaveBounds)
  mainWindow.on('unmaximize', scheduleSaveBounds)
  mainWindow.on('close', saveWindowBounds)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadFile(path.join(__dirname, 'loading.html')).catch(() => {})
  mainWindow.once('ready-to-show', () => {
    if (!setupWindow && !mainWindow?.isVisible()) mainWindow.show()
  })
  if (settings?.window?.maximized) mainWindow.maximize()
  return mainWindow
}

function scheduleSaveBounds() {
  clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(saveWindowBounds, 500)
}

function saveWindowBounds() {
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

function openSetupWindow(reason, errorMessage = '') {
  settings = settings || readSettings()
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show()
    setupWindow.focus()
    void setupWindow.loadFile(path.join(__dirname, 'setup.html'), {
      query: setupQuery(reason, errorMessage),
    })
    return setupWindow
  }
  setupWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 540,
    minHeight: 620,
    title: '连接 MultiPush',
    show: false,
    backgroundColor: '#f7f8fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  })
  setupWindow.setMenuBarVisibility(false)
  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  setupWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  setupWindow.once('ready-to-show', () => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.show()
  })
  setupWindow.on('closed', () => {
    setupWindow = null
    if (!connectionReady && !quitting) app.quit()
  })
  void setupWindow.loadFile(path.join(__dirname, 'setup.html'), {
    query: setupQuery(reason, errorMessage),
  })
  return setupWindow
}

function setupQuery(reason, errorMessage) {
  return {
    reason: reason || 'change',
    error: errorMessage || '',
    current: settings?.serverUrl || fallbackServer(),
    version: app.getVersion(),
  }
}

function upgradeConnectionUrl(loadedUrl) {
  if (!connectionUrl) return
  if (!loadedUrl.startsWith('https://')) return
  if (sameServer(loadedUrl, connectionUrl)) return
  try {
    const base = new URL(connectionUrl)
    const loaded = new URL(loadedUrl)
    if (base.protocol !== 'http:' || base.hostname !== loaded.hostname || loaded.protocol !== 'https:') return
    const next = normalizeServer(`${loaded.origin}${base.pathname}`)
    connectionUrl = next
    if (settings) settings.serverUrl = next
    writeSettings()
  } catch {
    // Keep the configured URL when the redirect cannot be normalized.
  }
}

function showConnectionFailure(message) {
  const key = connectionUrl || ''
  if (failureShownFor === key) return
  failureShownFor = key
  openSetupWindow('unreachable', message)
}

async function loadApp(serverUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
  connectionUrl = serverUrl
  connectionReady = false
  failureShownFor = null
  if (!mainWindow.isVisible()) mainWindow.show()
  try {
    await mainWindow.loadURL(`${serverUrl}/`)
    connectionReady = true
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close()
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ERR_ABORTED|aborted/i.test(message)) return false
    showConnectionFailure(`无法打开 ${serverUrl}：${message}`)
    return false
  }
}

function reloadApp() {
  if (!connectionUrl) {
    openSetupWindow('change')
    return
  }
  void loadApp(connectionUrl)
}

function isAppUrl(target) {
  if (!connectionUrl) return false
  return sameServer(target, connectionUrl)
}

function sameServer(target, base) {
  try {
    const targetUrl = new URL(target)
    const baseUrl = new URL(base)
    if (targetUrl.origin !== baseUrl.origin) return false
    const basePath = baseUrl.pathname.replace(/\/+$/, '')
    if (!basePath || basePath === '/') return true
    return targetUrl.pathname === basePath || targetUrl.pathname.startsWith(`${basePath}/`)
  } catch {
    return false
  }
}

function isHttpsUpgrade(target) {
  if (!connectionUrl) return false
  try {
    const targetUrl = new URL(target)
    const baseUrl = new URL(connectionUrl)
    return baseUrl.protocol === 'http:'
      && targetUrl.protocol === 'https:'
      && targetUrl.hostname === baseUrl.hostname
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
    label: '连接',
    submenu: [
      {
        label: '切换服务器…',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => openSetupWindow('change'),
      },
      {
        label: '重新连接',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () => reloadApp(),
      },
      { type: 'separator' },
      {
        label: '在浏览器中打开',
        click: () => {
          if (connectionUrl) void shell.openExternal(connectionUrl)
        },
      },
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
    `服务器 ${settings?.serverUrl || '未连接'}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    '',
    '一次创作，智能渲染，适配微信公众号、小红书、知乎、抖音。',
  ].join('\n')
  void showMessageBox({
    type: 'info',
    title: '关于 MultiPush',
    message: 'MultiPush 桌面客户端',
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

function registerIpc() {
  ipcMain.handle('desktop:get-state', (event) => {
    assertSetupSender(event)
    return {
      current: settings?.serverUrl || fallbackServer(),
      defaultServer: fallbackServer(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
    }
  })

  ipcMain.handle('desktop:test-server', async (event, value) => {
    assertSetupSender(event)
    try {
      const url = normalizeServer(value)
      const result = await probeServer(url)
      return { ok: true, url, version: result.version }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('desktop:connect', async (event, value) => {
    assertSetupSender(event)
    try {
      const url = normalizeServer(value)
      const result = await probeServer(url)
      settings.serverUrl = url
      writeSettings()
      connectionUrl = url
      void loadApp(url)
      return { ok: true, url, version: result.version }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('desktop:open-setup', (event) => {
    assertSetupSender(event)
    openSetupWindow('change')
    return true
  })

  ipcMain.handle('desktop:open-external', (event, value) => {
    assertSetupSender(event)
    openExternal(value)
    return true
  })

  ipcMain.handle('desktop:quit', (event) => {
    assertSetupSender(event)
    quitting = true
    app.quit()
    return true
  })
}

function assertSetupSender(event) {
  const frameUrl = event.senderFrame?.url || ''
  if (!frameUrl.startsWith('file://')) {
    throw new Error('不允许的调用来源')
  }
}

async function probeServer(serverUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await net.fetch(`${serverUrl}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `MultiPushDesktop/${app.getVersion()}`,
      },
    })
    if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`)
    const body = await response.json().catch(() => null)
    if (!body || body.service !== 'multipush' || body.status !== 'ok') {
      throw new Error('该地址不是可用的 MultiPush 服务')
    }
    return { version: typeof body.version === 'string' ? body.version : '' }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('连接超时，请检查服务器地址和网络')
    }
    const message = error instanceof Error ? error.message : String(error)
    if (/Failed to fetch|ERR_|ENOTFOUND|ECONN|EAI_AGAIN|net::|CERT_/i.test(message)) {
      throw new Error('无法连接到服务器，请检查地址、网络或 HTTPS 证书')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
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
