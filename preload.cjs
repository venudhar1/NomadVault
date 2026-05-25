const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vaultKey', {
  profiles: {
    load: () => ipcRenderer.invoke('profiles:load'),
    save: store => ipcRenderer.invoke('profiles:save', store),
  },
  transfer: {
    exportToFile: payload => ipcRenderer.invoke('profiles:exportToFile', payload),
    importFromFile: () => ipcRenderer.invoke('profiles:importFromFile'),
  },
});

// Expose limited API to renderer process
contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  version: process.versions.electron,
  getAppVersion: () => {
    try {
      const packageJson = require('./package.json');
      return packageJson.version;
    } catch (e) {
      return 'unknown';
    }
  },
});
