"use strict";

const fs = require("fs");
const path = require("path");

const STORE_FILE = "desktop-settings.json";

function createDesktopKeyStore(options) {
  const safeStorage = options.safeStorage;
  const userDataPath = options.userDataPath;
  const filePath = path.join(userDataPath, STORE_FILE);

  function isAvailable() {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  }

  function readStore() {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_error) {
      return {};
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  }

  function hasKey() {
    return Boolean(readStore().openAiApiKey);
  }

  function getKey() {
    if (!isAvailable()) {
      return "";
    }
    const encrypted = readStore().openAiApiKey;
    if (!encrypted) {
      return "";
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch (_error) {
      return "";
    }
  }

  function setKey(apiKey) {
    if (!isAvailable()) {
      const error = new Error("Secure desktop key storage is not available on this system.");
      error.code = "DESKTOP_KEY_STORAGE_UNAVAILABLE";
      throw error;
    }
    const store = readStore();
    store.openAiApiKey = safeStorage.encryptString(apiKey).toString("base64");
    writeStore(store);
  }

  function clearKey() {
    const store = readStore();
    delete store.openAiApiKey;
    writeStore(store);
  }

  return {
    clearKey,
    getKey,
    hasKey,
    isAvailable,
    setKey
  };
}

module.exports = {
  createDesktopKeyStore
};
