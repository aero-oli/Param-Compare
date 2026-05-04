"use strict";

function isAllowedExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

module.exports = {
  isAllowedExternalUrl
};
