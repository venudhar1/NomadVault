const { contextBridge } = require('electron');

// Expose limited API to renderer process
contextBridge.exposeInMainWorld('electron', {
  // Detect if running in Electron
  isElectron: true,
  version: process.versions.electron,
  
  // Get app version
  getAppVersion: () => {
    try {
      const packageJson = require('./package.json');
      return packageJson.version;
    } catch (e) {
      return 'unknown';
    }
  },
});
