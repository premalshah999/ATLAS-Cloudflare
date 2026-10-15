// ATLAS main process (manual E1–E4): windows, OS dialogs, daemon supervision and IPC routing.
// It never executes model-proposed commands; it forwards validated intents to the daemon.
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { IPC, parseRequest, PROVIDER_ENV, type Envelope, type Method } from '@atlas/contracts';
import { DaemonClient, type DaemonStatus } from './daemon';
import { credentials, deploySecrets } from './credentials';

const isMac = process.platform === 'darwin';
const devUrl = process.env.VITE_DEV_SERVER_URL;
const e2e = process.env.ATLAS_E2E === '1';
const rendererIndex = path.join(__dirname, '..', 'dist', 'index.html');
const EXTERNAL_ALLOW = [/^https:\/\/(www\.)?github\.com\//, /^https:\/\/pi\.dev\//, /^https:\/\/code\.claude\.com\//];

if (process.env.ATLAS_USER_DATA) app.setPath('userData', process.env.ATLAS_USER_DATA);
const dataDir = () => path.join(app.getPath('userData'), 'data');
const logFile = () => path.join(app.getPath('userData'), 'logs', 'main.log');
function log(msg: string) {
  try { mkdirSync(path.dirname(logFile()), { recursive: true }); appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`); } catch { /* logging is best-effort */ }
}

let win: BrowserWindow | null = null;
let daemon: DaemonClient;

/** Only the app's own renderer may call the API. */
function trustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (!win || e.sender.id !== win.webContents.id || e.senderFrame !== e.sender.mainFrame) return false;
  if (devUrl) return url.startsWith(devUrl);
  return url.startsWith('file://') && decodeURIComponent(new URL(url).pathname).endsWith(path.join('dist', 'index.html').replace(/\\/g, '/'));
}

function daemonEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  // Finder launches have a minimal PATH; include common user-installed Node/Git locations.
  if (isMac) {
    const extra = [path.join(app.getPath('home'), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(existsSync);
    env.PATH = [...new Set([...(env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(path.delimiter), ...extra])].join(path.delimiter);
  }
  // Where to find a browser for QA; never credentials.
  for (const k of ['PLAYWRIGHT_BROWSERS_PATH', 'ATLAS_CHROMIUM_PATH', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY']) if (process.env[k]) env[k] = process.env[k]!;
  // Proxy/CA settings, forwarded by the sandbox only to commands granted network access.
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) if (process.env[k]) env[k] = process.env[k]!;
  env.ATLAS_DATA_DIR = dataDir();
  env.ATLAS_VERSION = app.getVersion();
  env.PI_TELEMETRY = '0';
  if (process.env.ATLAS_MODEL) env.ATLAS_MODEL = process.env.ATLAS_MODEL;
  for (const [provider, key] of Object.entries(credentials.keys())) env[PROVIDER_ENV[provider]] = key;
  const ds = deploySecrets.decrypted();
  if (Object.keys(ds).length) env.ATLAS_DEPLOY_SECRETS = JSON.stringify(ds);
  return env;
}

async function route(method: Method, params: any): Promise<unknown> {
  switch (method) {
    case 'workspace.open': {
      let dir: string | undefined;
      if (e2e && process.env.ATLAS_E2E_OPEN_DIR) dir = process.env.ATLAS_E2E_OPEN_DIR;
      else {
        const opts = { title: 'Open repository', properties: ['openDirectory' as const] };
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        dir = res.canceled ? undefined : res.filePaths[0];
      }
      if (!dir) return null;
      // The path came from an OS dialog in main, never from renderer input.
      return daemon.request('workspace.register', { path: dir });
    }
    case 'mission.export': {
      let file: string | undefined;
      if (e2e && process.env.ATLAS_E2E_SAVE_PATH) file = process.env.ATLAS_E2E_SAVE_PATH;
      else {
        const opts = { title: 'Export mission', defaultPath: `${params.missionId}.atlas.jsonl`, filters: [{ name: 'ATLAS export', extensions: ['jsonl'] }] };
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        file = res.canceled ? undefined : res.filePath;
      }
      if (!file) return null;
      return { path: file, ...(await daemon.request<object>('mission.exportTo', { missionId: params.missionId, path: file })) };
    }
    case 'mission.import': {
      let file: string | undefined;
      if (e2e && process.env.ATLAS_E2E_IMPORT_PATH) file = process.env.ATLAS_E2E_IMPORT_PATH;
      else {
        const opts = { title: 'Import mission', properties: ['openFile' as const], filters: [{ name: 'ATLAS export', extensions: ['jsonl'] }] };
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        file = res.canceled ? undefined : res.filePaths[0];
      }
      if (!file) return null;
      return daemon.request('mission.importFrom', { path: file });
    }
    case 'app.info': {
      const info = await daemon.request<Record<string, unknown>>('app.info', {});
      return { ...info, electron: process.versions.electron, chrome: process.versions.chrome, daemon: daemon.status, credentialStore: credentials.available() };
    }
    case 'credentials.list': return { available: credentials.available(), providers: credentials.list() };
    case 'credentials.set':
      credentials.set(params.provider, params.key);
      await daemon.request('credentials.apply', { keys: credentials.keys(), deploySecrets: deploySecrets.decrypted() });
      return { available: credentials.available(), providers: credentials.list() };
    case 'deploy.secrets.list': return deploySecrets.list();
    case 'deploy.secrets.set':
      deploySecrets.set(params.target, params.name, params.value);
      await daemon.request('credentials.apply', { keys: credentials.keys(), deploySecrets: deploySecrets.decrypted() });
      return deploySecrets.list();
    case 'deploy.secrets.remove':
      deploySecrets.remove(params.target, params.name);
      await daemon.request('credentials.apply', { keys: credentials.keys(), deploySecrets: deploySecrets.decrypted() });
      return deploySecrets.list();
    case 'credentials.remove':
      credentials.remove(params.provider);
      await daemon.request('credentials.apply', { keys: credentials.keys() });
      return { available: credentials.available(), providers: credentials.list() };
    default:
      return daemon.request(method, params);
  }
}

function registerIpc() {
  ipcMain.handle(IPC.invoke, async (e, method: unknown, payload: unknown): Promise<Envelope<unknown>> => {
    if (!trustedSender(e)) {
      log(`DENIED untrusted sender ${e.senderFrame?.url ?? '?'} method=${String(method).slice(0, 40)}`);
      return { ok: false, error: { kind: 'forbidden', message: 'Untrusted sender' } };
    }
    let parsed: ReturnType<typeof parseRequest>;
    try {
      parsed = parseRequest(String(method), payload);
    } catch (err) {
      log(`DENIED malformed request method=${String(method).slice(0, 40)}: ${(err as Error).message.slice(0, 200)}`);
      return { ok: false, error: { kind: 'invalid_request', message: (err as Error).name === 'ZodError' ? 'Malformed request' : (err as Error).message } };
    }
    try {
      return { ok: true, data: await route(parsed.method as Method, parsed.params) };
    } catch (err) {
      return { ok: false, error: { kind: (err as { kind?: string }).kind ?? 'internal', message: (err as Error).message } };
    }
  });
  if (e2e) {
    // Test-only controls, never registered in normal runs.
    ipcMain.handle('atlas:e2e:crash-daemon', (e) => { if (trustedSender(e)) daemon.crash(); });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680, show: false, backgroundColor: '#08090c', title: 'ATLAS',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: '#08090c', symbolColor: '#9299a7', height: 40 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_ALLOW.some((re) => re.test(url))) void shell.openExternal(url);
    else log(`blocked window.open ${url.slice(0, 200)}`);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const own = devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
    if (!own) { e.preventDefault(); log(`blocked navigation ${url.slice(0, 200)}`); }
  });
  win.webContents.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason}`));
  win.on('closed', () => { win = null; });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererIndex);
}

// Process-wide sandbox. `--no-sandbox` is honored only for root CI containers; renderers keep sandbox: true regardless.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
app.whenReady().then(() => {
  // Deny every permission request (camera, notifications, …) from web content.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  daemon = new DaemonClient(
    path.join(__dirname, 'daemon.mjs'),
    daemonEnv,
    (event) => win?.webContents.send(IPC.event, event),
    (status: DaemonStatus) => { log(`daemon ${status.state} pid=${status.pid}`); win?.webContents.send(IPC.status, status); },
    (t) => win?.webContents.send(IPC.terminal, t),
    log,
  );
  daemon.start();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void daemon?.stop().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
