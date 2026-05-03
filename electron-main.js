"use strict";

const { app, BrowserWindow, Menu, safeStorage, shell } = require("electron");
const { createApp } = require("./server");
const { createDesktopKeyStore } = require("./desktop-key-store");

let mainWindow = null;
let expressServer = null;
let isQuitting = false;

function listenOnRandomPort(expressApp) {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

async function createMainWindow() {
  const desktopKeyStore = createDesktopKeyStore({
    safeStorage,
    userDataPath: app.getPath("userData")
  });
  const expressApp = createApp({ desktopKeyStore });
  expressServer = await listenOnRandomPort(expressApp);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "ArduPilot Param Compare",
    backgroundColor: "#151a1f",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#151a1f",
      symbolColor: "#eef3f6",
      height: 32
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(serverUrl(expressServer))) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!isQuitting) {
      closeExpressServer();
    }
  });

  await mainWindow.loadURL(serverUrl(expressServer));
}

function closeExpressServer() {
  if (!expressServer) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    expressServer.close(() => {
      expressServer = null;
      resolve();
    });
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (!expressServer) {
    return;
  }
  event.preventDefault();
  closeExpressServer().finally(() => app.exit(0));
});
