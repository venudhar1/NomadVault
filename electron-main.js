import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_FILE = 'profiles.json';

let mainWindow;

function getProfilesFilePath() {
  return path.join(app.getPath('userData'), PROFILES_FILE);
}

function readProfilesFromDisk() {
  try {
    const filePath = getProfilesFilePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('Failed to read profiles file:', error);
    return null;
  }
}

function writeProfilesToDisk(store) {
  const filePath = getProfilesFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}

ipcMain.handle('profiles:load', () => readProfilesFromDisk());

ipcMain.handle('profiles:save', (_event, store) => {
  try {
    writeProfilesToDisk(store);
    return true;
  } catch (error) {
    console.error('Failed to write profiles file:', error);
    return false;
  }
});

ipcMain.handle('profiles:exportToFile', async (event, { content, fileName }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(window ?? undefined, {
    title: 'Export vault profile',
    defaultPath: fileName,
    filters: [{ name: 'VaultKey profile', extensions: ['json'] }],
  });

  if (canceled || !filePath) {
    return { ok: false, cancelled: true };
  }

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, cancelled: false, filePath };
  } catch (error) {
    console.error('Failed to export profile file:', error);
    return { ok: false, cancelled: false };
  }
});

ipcMain.handle('profiles:importFromFile', async event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Import vault profile',
    filters: [{ name: 'VaultKey profile', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (canceled || !filePaths?.[0]) {
    return { ok: false, cancelled: true };
  }

  try {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { ok: true, cancelled: false, content };
  } catch (error) {
    console.error('Failed to import profile file:', error);
    return { ok: false, cancelled: false };
  }
});

function createWindow() {
  const shouldLoadDist =
    app.isPackaged ||
    process.env.VAULTKEY_LOAD_DIST === 'true' ||
    process.env.npm_lifecycle_event === 'electron-prod';
  const isDev = !shouldLoadDist;
  const iconPath = path.join(__dirname, 'assets/icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      partition: 'persist:vaultkey',
    },
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create window when app is ready
app.on('ready', createWindow);

// Quit when all windows are closed (except on Mac)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Re-create window when app is activated (Mac)
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Create application menu
const template = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Exit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.quit();
        },
      },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  },
  {
    label: 'Help',
    submenu: [
      {
        label: 'About VaultKey',
        click: () => {
          // Could open an about dialog here
        },
      },
    ],
  },
];

Menu.setApplicationMenu(Menu.buildFromTemplate(template));
