"use strict";

const DEFAULT_METADATA_URL = "https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.json";
const DEFAULT_VERSIONED_METADATA_URL_TEMPLATE =
  "https://autotest.ardupilot.org/Parameters/versioned/Copter/{version}/apm.pdef.json";
const STATUS_ORDER = { changed: 0, added: 1, removed: 2, same: 3 };
const STATUS_LABELS = {
  changed: "Changed",
  added: "Added",
  removed: "Removed",
  same: "Same"
};
const FLOAT_REL_TOL = 1e-9;
const FLOAT_ABS_TOL = 1e-12;
const CACHE_PREFIX = "ardupilot-param-compare-cache:";
const TOOLTIP_OFFSET = 16;
const DEFAULT_AI_SETTINGS = {
  model: "gpt-5.4-mini",
  reasoning_effort: "low",
  verbosity: "medium",
  max_output_tokens: 2400,
  service_tier: "auto",
  web_search_enabled: true,
  web_search_context_size: "medium",
  external_web_access: true,
  temperature: null
};

const state = {
  allRows: [],
  filteredRows: [],
  metadata: new Map(),
  metadataSource: "Not loaded yet",
  selectedRowId: "",
  hoveredRowId: "",
  focusedParamNames: new Set(),
  files: {
    oldName: "",
    newName: ""
  },
  ai: {
    sessionReady: false,
    contextReady: false,
    contextDirty: true,
    isBusy: false,
    panelOpen: false,
    activeTab: "chat",
    settings: { ...DEFAULT_AI_SETTINGS },
    messages: []
  }
};

const elements = {
  oldFileInput: document.getElementById("oldFileInput"),
  newFileInput: document.getElementById("newFileInput"),
  metadataFileInput: document.getElementById("metadataFileInput"),
  versionRefInput: document.getElementById("versionRefInput"),
  metadataUrlInput: document.getElementById("metadataUrlInput"),
  ignoreInput: document.getElementById("ignoreInput"),
  sortByInput: document.getElementById("sortByInput"),
  showSameInput: document.getElementById("showSameInput"),
  compareButton: document.getElementById("compareButton"),
  resetVersionButton: document.getElementById("resetVersionButton"),
  searchInput: document.getElementById("searchInput"),
  filterChanged: document.getElementById("filterChanged"),
  filterAdded: document.getElementById("filterAdded"),
  filterRemoved: document.getElementById("filterRemoved"),
  filterSame: document.getElementById("filterSame"),
  exportHtmlButton: document.getElementById("exportHtmlButton"),
  exportCsvButton: document.getElementById("exportCsvButton"),
  focusVisibleChangedButton: document.getElementById("focusVisibleChangedButton"),
  clearVisibleFocusButton: document.getElementById("clearVisibleFocusButton"),
  resultsBody: document.getElementById("resultsBody"),
  statusText: document.getElementById("statusText"),
  metadataStatusText: document.getElementById("metadataStatusText"),
  summaryChanged: document.getElementById("summaryChanged"),
  summaryAdded: document.getElementById("summaryAdded"),
  summaryRemoved: document.getElementById("summaryRemoved"),
  summarySame: document.getElementById("summarySame"),
  summaryShown: document.getElementById("summaryShown"),
  detailName: document.getElementById("detailName"),
  detailStatus: document.getElementById("detailStatus"),
  detailOldValue: document.getElementById("detailOldValue"),
  detailNewValue: document.getElementById("detailNewValue"),
  detailDisplayName: document.getElementById("detailDisplayName"),
  detailUnits: document.getElementById("detailUnits"),
  detailRange: document.getElementById("detailRange"),
  detailDecoded: document.getElementById("detailDecoded"),
  detailNotes: document.getElementById("detailNotes"),
  detailDescription: document.getElementById("detailDescription"),
  toggleFocusSelectedButton: document.getElementById("toggleFocusSelectedButton"),
  openAiButton: document.getElementById("openAiButton"),
  clearInspectorFocusButton: document.getElementById("clearInspectorFocusButton"),
  inspectorFocusedParamChips: document.getElementById("inspectorFocusedParamChips"),
  aiLauncherButton: document.getElementById("aiLauncherButton"),
  aiDrawerBackdrop: document.getElementById("aiDrawerBackdrop"),
  aiAssistantDrawer: document.getElementById("aiAssistantDrawer"),
  closeAiDrawerButton: document.getElementById("closeAiDrawerButton"),
  aiTabButtons: Array.from(document.querySelectorAll("[data-ai-tab]")),
  aiTabPanels: {
    chat: document.getElementById("aiTabChat"),
    setup: document.getElementById("aiTabSetup"),
    settings: document.getElementById("aiTabSettings")
  },
  aiChatSetupNotice: document.getElementById("aiChatSetupNotice"),
  aiChatConnectButton: document.getElementById("aiChatConnectButton"),
  openAiKeyInput: document.getElementById("openAiKeyInput"),
  connectAiButton: document.getElementById("connectAiButton"),
  prepareAiContextButton: document.getElementById("prepareAiContextButton"),
  cleanupAiButton: document.getElementById("cleanupAiButton"),
  aiSessionStatus: document.getElementById("aiSessionStatus"),
  aiContextStatus: document.getElementById("aiContextStatus"),
  aiModelInput: document.getElementById("aiModelInput"),
  aiModelOptions: document.getElementById("aiModelOptions"),
  aiReasoningInput: document.getElementById("aiReasoningInput"),
  aiVerbosityInput: document.getElementById("aiVerbosityInput"),
  aiMaxTokensInput: document.getElementById("aiMaxTokensInput"),
  aiWebSearchInput: document.getElementById("aiWebSearchInput"),
  aiWebContextInput: document.getElementById("aiWebContextInput"),
  aiLiveWebInput: document.getElementById("aiLiveWebInput"),
  aiServiceTierInput: document.getElementById("aiServiceTierInput"),
  aiTemperatureInput: document.getElementById("aiTemperatureInput"),
  focusedParamChips: document.getElementById("focusedParamChips"),
  clearAllFocusButton: document.getElementById("clearAllFocusButton"),
  aiChatLog: document.getElementById("aiChatLog"),
  aiQuestionInput: document.getElementById("aiQuestionInput"),
  askAiButton: document.getElementById("askAiButton"),
  tooltip: document.getElementById("tooltip")
};

function setStatus(text) {
  elements.statusText.textContent = text;
}

function setMetadataStatus(text) {
  elements.metadataStatusText.textContent = text;
}

function setAiSessionStatus(text) {
  elements.aiSessionStatus.textContent = text;
}

function setAiContextStatus(text) {
  elements.aiContextStatus.textContent = text;
}

function syncAiShellState() {
  elements.aiAssistantDrawer.classList.toggle("is-open", state.ai.panelOpen);
  elements.aiAssistantDrawer.setAttribute("aria-hidden", state.ai.panelOpen ? "false" : "true");
  elements.aiAssistantDrawer.inert = !state.ai.panelOpen;
  elements.aiLauncherButton.setAttribute("aria-expanded", state.ai.panelOpen ? "true" : "false");
  elements.aiDrawerBackdrop.hidden = !state.ai.panelOpen;
  elements.aiChatSetupNotice.hidden = state.ai.sessionReady;
}

function setAiTab(tab) {
  const nextTab = elements.aiTabPanels[tab] ? tab : "chat";
  state.ai.activeTab = nextTab;
  elements.aiTabButtons.forEach((button) => {
    const isActive = button.dataset.aiTab === nextTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  Object.entries(elements.aiTabPanels).forEach(([key, panel]) => {
    panel.classList.toggle("is-active", key === nextTab);
    panel.hidden = key !== nextTab;
  });
}

function openAiPanel(tab = "chat") {
  state.ai.panelOpen = true;
  setAiTab(tab);
  syncAiShellState();
}

function closeAiPanel() {
  state.ai.panelOpen = false;
  syncAiShellState();
}

function setAiBusy(isBusy) {
  state.ai.isBusy = isBusy;
  elements.connectAiButton.disabled = isBusy;
  elements.prepareAiContextButton.disabled = isBusy || !state.ai.sessionReady || !state.allRows.length;
  elements.askAiButton.disabled = isBusy || !state.ai.sessionReady || !state.allRows.length;
  elements.aiChatConnectButton.disabled = isBusy;
  elements.cleanupAiButton.disabled = isBusy || !state.ai.sessionReady;
  syncAiShellState();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with HTTP ${response.status}`);
  }
  return data;
}

function normalizeVersionRef(raw) {
  const input = raw.trim();
  if (!input) {
    return "";
  }
  if (input.toLowerCase().startsWith("stable-")) {
    return input;
  }
  const match = input.match(/(\d+\.\d+\.\d+)$/);
  if (match) {
    return `stable-${match[1]}`;
  }
  return input;
}

function resolveMetadataUrl(metadataUrl, versionRef) {
  const baseUrl = (metadataUrl || "").trim() || DEFAULT_METADATA_URL;
  const normalizedVersion = normalizeVersionRef(versionRef);
  if (!normalizedVersion) {
    return baseUrl;
  }
  if (baseUrl.includes("{version}")) {
    return baseUrl.replaceAll("{version}", normalizedVersion);
  }
  if (baseUrl === DEFAULT_METADATA_URL) {
    return DEFAULT_VERSIONED_METADATA_URL_TEMPLATE.replace("{version}", normalizedVersion);
  }
  return baseUrl;
}

function cacheKeyForUrl(url) {
  return `${CACHE_PREFIX}${url}`;
}

function writeCache(url, text) {
  try {
    localStorage.setItem(cacheKeyForUrl(url), text);
  } catch (_error) {
    // Ignore cache failures.
  }
}

function readCache(url) {
  try {
    return localStorage.getItem(cacheKeyForUrl(url));
  } catch (_error) {
    return null;
  }
}

async function fetchTextWithCache(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    writeCache(url, text);
    return { text, source: `downloaded: ${url}` };
  } catch (error) {
    const cached = readCache(url);
    if (cached !== null) {
      return { text: cached, source: `cached: ${url} (${error.message})` };
    }
    throw error;
  }
}

function stripInlineComment(line) {
  let output = line;
  for (const marker of ["#", "//", ";"]) {
    const index = output.indexOf(marker);
    if (index >= 0) {
      output = output.slice(0, index);
    }
  }
  return output.trim();
}

function parseParamText(text) {
  const params = new Map();
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) {
      continue;
    }
    const parts = line.split(/[\t,= ]+/).filter(Boolean);
    if (parts.length < 2) {
      continue;
    }
    params.set(parts[0].trim(), parts[1].trim());
  }
  return params;
}

function decimalish(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function normalizeValueMap(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return null;
  }
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    output[String(key).trim()] = String(value).trim();
  }
  return Object.keys(output).length ? output : null;
}

function normalizeBitmaskMap(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return null;
  }
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    const parsedKey = Number.parseInt(String(key).trim(), 10);
    if (!Number.isNaN(parsedKey)) {
      output[parsedKey] = String(value).trim();
    }
  }
  return Object.keys(output).length ? output : null;
}

function flattenJsonMetadata(node, output) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const hintKeys = ["Description", "DisplayName", "Units", "Range", "Values", "Bitmask", "User", "RebootRequired"];
      const looksLikeMeta = hintKeys.some((hint) => hint in value);
      if (looksLikeMeta) {
        const range = value.Range && typeof value.Range === "object" ? value.Range : {};
        output.set(String(key), {
          name: String(key),
          displayName: decimalish(value.DisplayName),
          description: decimalish(value.Description),
          units: decimalish(value.Units),
          user: decimalish(value.User),
          low: decimalish(range.low),
          high: decimalish(range.high),
          values: normalizeValueMap(value.Values),
          bitmask: normalizeBitmaskMap(value.Bitmask),
          rebootRequired: decimalish(value.RebootRequired)
        });
      } else {
        flattenJsonMetadata(value, output);
      }
    }
  }
}

function parseJsonMetadata(text) {
  const parsed = JSON.parse(text);
  const output = new Map();
  flattenJsonMetadata(parsed, output);
  return output;
}

function parseBitmaskField(raw) {
  if (!raw) {
    return null;
  }
  const output = {};
  for (const item of raw.split(",")) {
    const [bit, ...rest] = item.split(":");
    const label = rest.join(":").trim();
    const parsedBit = Number.parseInt((bit || "").trim(), 10);
    if (!Number.isNaN(parsedBit) && label) {
      output[parsedBit] = label;
    }
  }
  return Object.keys(output).length ? output : null;
}

function parseXmlMetadata(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    throw new Error("Invalid XML metadata");
  }

  const output = new Map();
  const params = xml.querySelectorAll("param");
  params.forEach((paramElem) => {
    let name = (paramElem.getAttribute("name") || "").trim();
    if (name.includes(":")) {
      name = name.split(":").pop().trim();
    }
    if (!name) {
      return;
    }

    const fields = new Map();
    paramElem.querySelectorAll(":scope > field").forEach((field) => {
      const fieldName = (field.getAttribute("name") || "").trim();
      if (fieldName) {
        fields.set(fieldName, field.textContent.trim());
      }
    });

    const values = {};
    paramElem.querySelectorAll(":scope > values > value").forEach((valueElem) => {
      const code = (valueElem.getAttribute("code") || "").trim();
      if (code) {
        values[code] = valueElem.textContent.trim();
      }
    });

    let bitmask = null;
    const explicitBits = {};
    paramElem.querySelectorAll(":scope > bitmask > bit").forEach((bitElem) => {
      const code = Number.parseInt((bitElem.getAttribute("code") || "").trim(), 10);
      if (!Number.isNaN(code)) {
        explicitBits[code] = bitElem.textContent.trim();
      }
    });
    if (Object.keys(explicitBits).length) {
      bitmask = explicitBits;
    } else {
      bitmask = parseBitmaskField(fields.get("Bitmask") || "");
    }

    const rangeText = fields.get("Range") || "";
    const rangeParts = rangeText.split(/\s+/).filter(Boolean);

    output.set(name, {
      name,
      displayName: (paramElem.getAttribute("humanName") || "").trim() || (fields.get("DisplayName") || ""),
      description: (paramElem.getAttribute("documentation") || "").trim() || (fields.get("Description") || ""),
      units: fields.get("Units") || "",
      user: (paramElem.getAttribute("user") || "").trim() || (fields.get("User") || ""),
      low: rangeParts[0] || "",
      high: rangeParts[1] || "",
      values: Object.keys(values).length ? values : null,
      bitmask,
      rebootRequired: fields.get("RebootRequired") || ""
    });
  });

  return output;
}

async function loadMetadata() {
  const metadataFile = elements.metadataFileInput.files[0];
  if (metadataFile) {
    const text = await metadataFile.text();
    const metadata = metadataFile.name.toLowerCase().endsWith(".xml")
      ? parseXmlMetadata(text)
      : parseJsonMetadata(text);
    return { metadata, source: `local file: ${metadataFile.name}` };
  }

  const resolvedUrl = resolveMetadataUrl(elements.metadataUrlInput.value, elements.versionRefInput.value);
  try {
    const jsonResult = await fetchTextWithCache(resolvedUrl);
    return { metadata: parseJsonMetadata(jsonResult.text), source: jsonResult.source };
  } catch (jsonError) {
    const xmlUrl = resolvedUrl.toLowerCase().endsWith(".json")
      ? `${resolvedUrl.slice(0, -5)}.xml`
      : "";

    if (!xmlUrl) {
      throw new Error(`Could not load metadata from ${resolvedUrl}: ${jsonError.message}`);
    }

    try {
      const xmlResult = await fetchTextWithCache(xmlUrl);
      return { metadata: parseXmlMetadata(xmlResult.text), source: `${xmlResult.source} (XML fallback)` };
    } catch (xmlError) {
      throw new Error(
        `Could not load metadata from ${resolvedUrl} or XML fallback ${xmlUrl}. ` +
        "Use a published Copter version such as 4.5.7, stable-4.5.7, or Copter-4.5.7, or load a local metadata file."
      );
    }
  }
}

function toNumber(value) {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function valuesEqual(a, b) {
  if (a === b) {
    return true;
  }
  const numberA = toNumber(a);
  const numberB = toNumber(b);
  if (numberA === null || numberB === null) {
    return false;
  }
  return Math.abs(numberA - numberB) <= Math.max(FLOAT_ABS_TOL, FLOAT_REL_TOL * Math.max(Math.abs(numberA), Math.abs(numberB)));
}

function formatRange(meta) {
  if (!meta || (!meta.low && !meta.high)) {
    return "";
  }
  return `${meta.low} .. ${meta.high}`.trim();
}

function canonicalNumericString(value) {
  const number = toNumber(value);
  if (number === null) {
    return "";
  }
  if (Number.isInteger(number)) {
    return String(number);
  }
  return String(number).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function decodeEnumOrBitmask(rawValue, meta) {
  if (!meta) {
    return "";
  }

  if (meta.values) {
    if (meta.values[rawValue] !== undefined) {
      return meta.values[rawValue];
    }
    const candidates = new Set([rawValue, canonicalNumericString(rawValue)]);
    const number = toNumber(rawValue);
    if (number !== null && Number.isInteger(number)) {
      candidates.add(String(number));
    }
    for (const candidate of candidates) {
      if (candidate && meta.values[candidate] !== undefined) {
        return meta.values[candidate];
      }
    }
  }

  if (meta.bitmask) {
    const number = toNumber(rawValue);
    if (number === null || !Number.isInteger(number)) {
      return "";
    }
    if (number === 0 && meta.bitmask[0] !== undefined) {
      return meta.bitmask[0];
    }
    const labels = Object.entries(meta.bitmask)
      .map(([bit, label]) => ({ bit: Number(bit), label }))
      .sort((a, b) => a.bit - b.bit)
      .filter(({ bit }) => (number & (1 << bit)) !== 0)
      .map(({ label }) => label);
    return labels.join(" | ");
  }

  return "";
}

function rangeNote(rawValue, meta) {
  if (!meta || (!meta.low && !meta.high)) {
    return "";
  }
  const value = toNumber(rawValue);
  if (value === null) {
    return "";
  }
  const notes = [];
  const low = toNumber(meta.low);
  const high = toNumber(meta.high);
  if (low !== null && value < low) {
    notes.push("below documented range");
  }
  if (high !== null && value > high) {
    notes.push("above documented range");
  }
  return notes.join("; ");
}

function buildRows(oldParams, newParams, metadata, showOnlyDifferences, ignoreParams) {
  const names = Array.from(new Set([...oldParams.keys(), ...newParams.keys()])).sort();
  const rows = [];

  names.forEach((name, index) => {
    if (ignoreParams.has(name)) {
      return;
    }

    const oldValue = oldParams.get(name) || "";
    const newValue = newParams.get(name) || "";
    const meta = metadata.get(name) || null;

    let status = "changed";
    if (!oldParams.has(name)) {
      status = "added";
    } else if (!newParams.has(name)) {
      status = "removed";
    } else if (valuesEqual(oldValue, newValue)) {
      status = "same";
    }

    if (showOnlyDifferences && status === "same") {
      return;
    }

    const notes = [
      rangeNote(oldValue, meta),
      rangeNote(newValue, meta),
      meta ? meta.rebootRequired : ""
    ].filter(Boolean).join("; ");

    rows.push({
      id: `row-${index}-${name}`,
      status,
      name,
      oldValue,
      newValue,
      displayName: meta ? meta.displayName : "",
      units: meta ? meta.units : "",
      allowedRange: formatRange(meta),
      oldDecoded: decodeEnumOrBitmask(oldValue, meta),
      newDecoded: decodeEnumOrBitmask(newValue, meta),
      description: meta ? meta.description : "",
      notes
    });
  });

  return rows;
}

function sortRows(rows, sortBy) {
  const sorted = [...rows];
  if (sortBy === "status") {
    sorted.sort((a, b) => {
      const statusDelta = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
      return statusDelta || a.name.localeCompare(b.name);
    });
    return sorted;
  }
  sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

function statusCounts(rows) {
  const counts = { changed: 0, added: 0, removed: 0, same: 0 };
  rows.forEach((row) => {
    counts[row.status] += 1;
  });
  return counts;
}

function getEnabledStatuses() {
  const enabled = new Set();
  if (elements.filterChanged.checked) {
    enabled.add("changed");
  }
  if (elements.filterAdded.checked) {
    enabled.add("added");
  }
  if (elements.filterRemoved.checked) {
    enabled.add("removed");
  }
  if (elements.filterSame.checked && elements.showSameInput.checked) {
    enabled.add("same");
  }
  return enabled;
}

function syncFilterAvailability() {
  elements.filterSame.disabled = !elements.showSameInput.checked;
  elements.filterSame.closest("label").classList.toggle("is-disabled", !elements.showSameInput.checked);
}

function updateSummary() {
  const counts = statusCounts(state.allRows);
  elements.summaryChanged.textContent = String(counts.changed);
  elements.summaryAdded.textContent = String(counts.added);
  elements.summaryRemoved.textContent = String(counts.removed);
  elements.summarySame.textContent = String(counts.same);
  elements.summaryShown.textContent = String(state.filteredRows.length);
}

function clearDetails() {
  elements.detailName.textContent = "No row selected";
  elements.detailStatus.textContent = "-";
  elements.detailOldValue.textContent = "-";
  elements.detailNewValue.textContent = "-";
  elements.detailDisplayName.textContent = "-";
  elements.detailUnits.textContent = "-";
  elements.detailRange.textContent = "-";
  elements.detailDecoded.textContent = "-";
  elements.detailNotes.textContent = "-";
  elements.detailDescription.textContent = "Run a comparison, then select a parameter row to see the full metadata description.";
}

function renderDetails(row) {
  if (!row) {
    clearDetails();
    return;
  }
  elements.detailName.textContent = row.name;
  elements.detailStatus.textContent = STATUS_LABELS[row.status] || row.status;
  elements.detailOldValue.textContent = row.oldValue || "-";
  elements.detailNewValue.textContent = row.newValue || "-";
  elements.detailDisplayName.textContent = row.displayName || "-";
  elements.detailUnits.textContent = row.units || "-";
  elements.detailRange.textContent = row.allowedRange || "-";
  elements.detailDecoded.textContent = [row.oldDecoded ? `Old: ${row.oldDecoded}` : "", row.newDecoded ? `New: ${row.newDecoded}` : ""]
    .filter(Boolean)
    .join(" | ") || "-";
  elements.detailNotes.textContent = row.notes || "-";
  elements.detailDescription.textContent = row.description || "No description available.";
}

function currentSelection() {
  return state.filteredRows.find((row) => row.id === state.selectedRowId) || null;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusBadge(row) {
  return `<span class="status-badge status-badge-${escapeHtml(row.status)}">${escapeHtml(STATUS_LABELS[row.status] || row.status)}</span>`;
}

function focusToggleMarkup(row) {
  const isFocused = state.focusedParamNames.has(row.name);
  return `
    <button class="focus-toggle${isFocused ? " is-focused" : ""}" type="button" data-focus-param="${escapeHtml(row.name)}" aria-label="${isFocused ? "Remove AI focus" : "Add AI focus"} ${escapeHtml(row.name)}" title="${isFocused ? "Remove AI focus" : "Add AI focus"}">
      ${isFocused ? "✓" : "+"}
    </button>
  `;
}

function valueChangeMarkup(row) {
  if (row.status === "added") {
    return `<span class="value-missing">not present</span><span class="change-arrow">&rarr;</span><span class="mono value-new">${escapeHtml(row.newValue)}</span>`;
  }
  if (row.status === "removed") {
    return `<span class="mono value-old">${escapeHtml(row.oldValue)}</span><span class="change-arrow">&rarr;</span><span class="value-missing">not present</span>`;
  }
  return `<span class="mono value-old">${escapeHtml(row.oldValue)}</span><span class="change-arrow">&rarr;</span><span class="mono value-new">${escapeHtml(row.newValue)}</span>`;
}

function oldValueMarkup(row) {
  if (row.status === "added") {
    return "<span class=\"value-missing\">not present</span>";
  }
  return `<span class="mono value-old">${escapeHtml(row.oldValue)}</span>`;
}

function newValueMarkup(row) {
  if (row.status === "removed") {
    return "<span class=\"value-missing\">not present</span>";
  }
  return `<span class="mono value-new">${escapeHtml(row.newValue)}</span>`;
}

function decodedMarkup(row) {
  if (!row.oldDecoded && !row.newDecoded) {
    return "<span class=\"empty-meta\">No enum or bitmask label</span>";
  }
  if (row.status === "added") {
    return `<span class="empty-meta">not present</span><span class="change-arrow">&rarr;</span><span>${escapeHtml(row.newDecoded || "-")}</span>`;
  }
  if (row.status === "removed") {
    return `<span>${escapeHtml(row.oldDecoded || "-")}</span><span class="change-arrow">&rarr;</span><span class="empty-meta">not present</span>`;
  }
  return `<span>${escapeHtml(row.oldDecoded || "-")}</span><span class="change-arrow">&rarr;</span><span>${escapeHtml(row.newDecoded || "-")}</span>`;
}

function metadataMarkup(row) {
  const items = [];
  if (row.units) {
    items.push(`<span><strong>Units</strong>${escapeHtml(row.units)}</span>`);
  }
  if (row.allowedRange) {
    items.push(`<span><strong>Range</strong><code>${escapeHtml(row.allowedRange)}</code></span>`);
  }
  if (!items.length) {
    return "<span class=\"empty-meta\">No metadata</span>";
  }
  return `<div class="meta-stack">${items.join("")}</div>`;
}

function renderTable() {
  elements.resultsBody.innerHTML = "";
  if (!state.filteredRows.length) {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "empty-row";
    emptyRow.innerHTML = "<td colspan=\"8\">No rows match the current filters.</td>";
    elements.resultsBody.appendChild(emptyRow);
    renderDetails(null);
    updateSummary();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.filteredRows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.className = `status-${row.status}`;
    if (row.id === state.selectedRowId) {
      tr.classList.add("is-selected");
    }
    if (state.focusedParamNames.has(row.name)) {
      tr.classList.add("is-focused");
    }
    tr.dataset.rowId = row.id;
    tr.tabIndex = 0;
    tr.innerHTML = `
      <td>${focusToggleMarkup(row)}</td>
      <td>${statusBadge(row)}</td>
      <td>
        <div class="param-name">${escapeHtml(row.name)}</div>
        <div class="param-label">${escapeHtml(row.displayName || "No display name in metadata")}</div>
      </td>
      <td>${oldValueMarkup(row)}</td>
      <td>${newValueMarkup(row)}</td>
      <td><div class="change-pair decoded-pair">${decodedMarkup(row)}</div></td>
      <td>${metadataMarkup(row)}</td>
      <td>${escapeHtml(row.notes || "No notes")}</td>
    `;
    fragment.appendChild(tr);
  });
  elements.resultsBody.appendChild(fragment);

  const selected = currentSelection() || state.filteredRows[0] || null;
  if (selected) {
    state.selectedRowId = selected.id;
    highlightSelectedRow();
    renderDetails(selected);
  } else {
    renderDetails(null);
  }
  updateSummary();
  renderFocusChips();
}

function highlightSelectedRow() {
  elements.resultsBody.querySelectorAll("tr").forEach((tr) => {
    const row = rowById(tr.dataset.rowId || "");
    tr.classList.toggle("is-selected", tr.dataset.rowId === state.selectedRowId);
    tr.classList.toggle("is-focused", row ? state.focusedParamNames.has(row.name) : false);
  });
}

function applyFilters() {
  syncFilterAvailability();
  const enabledStatuses = getEnabledStatuses();
  const query = elements.searchInput.value.trim().toLowerCase();

  state.filteredRows = state.allRows.filter((row) => {
    if (!enabledStatuses.has(row.status)) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = [
      row.status,
      row.name,
      row.oldValue,
      row.newValue,
      row.oldDecoded,
      row.newDecoded,
      row.displayName,
      row.units,
      row.allowedRange,
      row.description,
      row.notes
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  if (!state.filteredRows.some((row) => row.id === state.selectedRowId)) {
    state.selectedRowId = state.filteredRows[0]?.id || "";
  }

  hideTooltip();
  renderTable();
}

function showTooltip(text, x, y) {
  if (!text) {
    hideTooltip();
    return;
  }
  elements.tooltip.textContent = text;
  elements.tooltip.hidden = false;
  elements.tooltip.style.left = `${Math.min(x + TOOLTIP_OFFSET, window.innerWidth - elements.tooltip.offsetWidth - 12)}px`;
  elements.tooltip.style.top = `${Math.min(y + TOOLTIP_OFFSET, window.innerHeight - elements.tooltip.offsetHeight - 12)}px`;
}

function hideTooltip() {
  state.hoveredRowId = "";
  elements.tooltip.hidden = true;
}

function rowById(id) {
  return state.filteredRows.find((row) => row.id === id) || null;
}

function rowByName(name) {
  return state.allRows.find((row) => row.name === name) || null;
}

function currentSelectedRow() {
  return state.allRows.find((row) => row.id === state.selectedRowId) || null;
}

function effectiveFocusNames() {
  const explicit = Array.from(state.focusedParamNames);
  if (explicit.length) {
    return explicit;
  }
  const selected = currentSelectedRow();
  return selected ? [selected.name] : [];
}

function markAiContextDirty(reason) {
  state.ai.contextDirty = true;
  state.ai.contextReady = false;
  if (state.ai.sessionReady) {
    setAiContextStatus(reason || "AI context needs to be prepared.");
  }
}

function setFocusedParam(name, isFocused) {
  if (!name || !rowByName(name)) {
    return;
  }
  if (isFocused) {
    state.focusedParamNames.add(name);
  } else {
    state.focusedParamNames.delete(name);
  }
  highlightSelectedRow();
  renderFocusChips();
  markAiContextDirty("Focus changed. Prepare context before the next AI answer.");
}

function toggleFocusedParam(name) {
  setFocusedParam(name, !state.focusedParamNames.has(name));
  renderTable();
}

function renderFocusChips() {
  const names = Array.from(state.focusedParamNames).sort();
  const containers = [elements.focusedParamChips, elements.inspectorFocusedParamChips];

  containers.forEach((container) => {
    container.innerHTML = "";
  });

  if (!names.length) {
    const selected = currentSelectedRow();
    containers.forEach((container) => {
      const fallback = document.createElement("span");
      fallback.className = "focus-chip";
      fallback.textContent = selected ? `Using selected: ${selected.name}` : "No focused params";
      container.appendChild(fallback);
    });
    elements.toggleFocusSelectedButton.textContent = "Focus";
    elements.toggleFocusSelectedButton.disabled = !selected;
    return;
  }

  containers.forEach((container) => {
    names.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "focus-chip";
      const label = document.createElement("span");
      label.textContent = name;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "x";
      button.setAttribute("aria-label", `Remove ${name} from AI focus`);
      button.addEventListener("click", () => {
        setFocusedParam(name, false);
        renderTable();
      });
      chip.append(label, button);
      container.appendChild(chip);
    });
  });

  const selected = currentSelectedRow();
  elements.toggleFocusSelectedButton.disabled = !selected;
  elements.toggleFocusSelectedButton.textContent = selected && state.focusedParamNames.has(selected.name)
    ? "Unfocus"
    : "Focus";
}

function serializeMetadataEntries() {
  return Array.from(state.metadata.values()).map((meta) => ({
    name: meta.name,
    displayName: meta.displayName,
    description: meta.description,
    units: meta.units,
    user: meta.user,
    low: meta.low,
    high: meta.high,
    values: meta.values,
    bitmask: meta.bitmask,
    rebootRequired: meta.rebootRequired
  }));
}

function aiSettingsFromInputs() {
  const temperatureRaw = elements.aiTemperatureInput.value.trim();
  return {
    model: elements.aiModelInput.value.trim() || DEFAULT_AI_SETTINGS.model,
    reasoning_effort: elements.aiReasoningInput.value,
    verbosity: elements.aiVerbosityInput.value,
    max_output_tokens: Number(elements.aiMaxTokensInput.value) || DEFAULT_AI_SETTINGS.max_output_tokens,
    service_tier: elements.aiServiceTierInput.value,
    web_search_enabled: elements.aiWebSearchInput.checked,
    web_search_context_size: elements.aiWebContextInput.value,
    external_web_access: elements.aiLiveWebInput.checked,
    temperature: temperatureRaw ? Number(temperatureRaw) : null
  };
}

function aiContextPayload() {
  const selected = currentSelectedRow();
  return {
    rows: state.allRows,
    metadataEntries: serializeMetadataEntries(),
    metadataSource: state.metadataSource,
    versionRef: elements.versionRefInput.value.trim(),
    files: { ...state.files },
    selectedParamName: selected ? selected.name : "",
    focusedParamNames: effectiveFocusNames()
  };
}

async function compareFiles() {
  const oldFile = elements.oldFileInput.files[0];
  const newFile = elements.newFileInput.files[0];
  if (!oldFile || !newFile) {
    setStatus("Select both parameter files before comparing.");
    return;
  }

  elements.compareButton.disabled = true;
  setStatus("Comparing files and loading metadata...");

  try {
    const [oldText, newText, metadataResult] = await Promise.all([
      oldFile.text(),
      newFile.text(),
      loadMetadata()
    ]);

    const oldParams = parseParamText(oldText);
    const newParams = parseParamText(newText);
    const ignoreParams = new Set(
      elements.ignoreInput.value
        .split(/[,;\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    );

    state.files.oldName = oldFile.name;
    state.files.newName = newFile.name;
    state.metadata = metadataResult.metadata;
    state.metadataSource = `${metadataResult.source} | ${metadataResult.metadata.size} metadata entries loaded`;
    setMetadataStatus(state.metadataSource);

    const rows = buildRows(
      oldParams,
      newParams,
      metadataResult.metadata,
      !elements.showSameInput.checked,
      ignoreParams
    );

    state.allRows = sortRows(rows, elements.sortByInput.value);
    state.selectedRowId = state.allRows[0]?.id || "";
    state.focusedParamNames = new Set(Array.from(state.focusedParamNames).filter((name) => rows.some((row) => row.name === name)));
    markAiContextDirty("Comparison changed. Prepare AI context.");
    applyFilters();
    setStatus(`Comparison complete. Showing ${state.filteredRows.length} of ${state.allRows.length} relevant rows.`);
    if (state.ai.sessionReady) {
      syncAiContext().catch((error) => {
        setAiContextStatus(`Context preparation failed: ${error.message}`);
      });
    }
  } catch (error) {
    console.error(error);
    setStatus(`Comparison failed: ${error.message}`);
    setMetadataStatus("Metadata load failed");
  } finally {
    elements.compareButton.disabled = false;
  }
}

function populateModelOptions(models) {
  elements.aiModelOptions.innerHTML = "";
  models.slice(0, 200).forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    elements.aiModelOptions.appendChild(option);
  });
}

async function connectAiSession() {
  openAiPanel("setup");
  const apiKey = elements.openAiKeyInput.value.trim();
  if (!apiKey) {
    setAiSessionStatus("Enter an OpenAI API key first.");
    return;
  }

  setAiBusy(true);
  setAiSessionStatus("Validating API key...");
  try {
    const result = await postJson("/api/openai/session", { apiKey });
    state.ai.sessionReady = true;
    state.ai.contextReady = false;
    state.ai.contextDirty = true;
    elements.openAiKeyInput.value = "";
    populateModelOptions(result.models || []);
    if (result.recommendedModel && !elements.aiModelInput.value.trim()) {
      elements.aiModelInput.value = result.recommendedModel;
    }
    setAiSessionStatus("AI connected. API key is held in backend memory only.");
    setAiContextStatus(state.allRows.length ? "Preparing AI context..." : "Run a comparison before preparing context.");
    if (state.allRows.length) {
      await syncAiContext();
    }
    setAiTab("chat");
  } catch (error) {
    state.ai.sessionReady = false;
    setAiSessionStatus(`AI connection failed: ${error.message}`);
  } finally {
    setAiBusy(false);
  }
}

async function syncAiContext() {
  if (!state.ai.sessionReady) {
    setAiContextStatus("Connect AI before preparing context.");
    return;
  }
  if (!state.allRows.length) {
    setAiContextStatus("Run a comparison before preparing context.");
    return;
  }

  setAiBusy(true);
  setAiContextStatus("Creating vector store and uploading comparison context...");
  try {
    const result = await postJson("/api/ai/context", aiContextPayload());
    state.ai.contextReady = true;
    state.ai.contextDirty = false;
    setAiContextStatus(
      `Context ready: ${result.fileCount} knowledge files in vector store${result.ready ? "" : " (still processing; first answer may wait)"}`
    );
  } catch (error) {
    state.ai.contextReady = false;
    state.ai.contextDirty = true;
    setAiContextStatus(`Context preparation failed: ${error.message}`);
    throw error;
  } finally {
    setAiBusy(false);
  }
}

function appendAiMessage(role, payload) {
  state.ai.messages.push({ role, payload, timestamp: new Date() });
  renderAiMessages();
}

function linkElement(url, title) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = title || url;
  return link;
}

function renderAiMessages() {
  elements.aiChatLog.innerHTML = "";
  if (!state.ai.messages.length) {
    const empty = document.createElement("div");
    empty.className = "ai-empty";
    empty.textContent = "Connect AI, run a comparison, focus one or more params, then ask a question.";
    elements.aiChatLog.appendChild(empty);
    return;
  }

  state.ai.messages.forEach((message) => {
    const card = document.createElement("article");
    card.className = `ai-message ai-message-${message.role}`;
    const header = document.createElement("div");
    header.className = "ai-message-header";
    header.innerHTML = `<span>${message.role === "user" ? "You" : "Assistant"}</span><span>${message.timestamp.toLocaleTimeString()}</span>`;
    const body = document.createElement("div");
    body.className = "ai-message-body";

    if (message.role === "user") {
      body.textContent = message.payload.question;
      card.append(header, body);
      elements.aiChatLog.appendChild(card);
      return;
    }

    const answer = message.payload.answer || {};
    body.textContent = answer.answer_markdown || "No answer returned.";
    card.append(header, body);

    const meta = document.createElement("div");
    meta.className = "ai-meta-list";
    const chips = [];
    if (answer.focus_params_used?.length) {
      chips.push(`Focus: ${answer.focus_params_used.join(", ")}`);
    }
    if (answer.referenced_params?.length) {
      chips.push(`Referenced: ${answer.referenced_params.join(", ")}`);
    }
    if (message.payload.effectiveSettings) {
      chips.push(`Model: ${message.payload.effectiveSettings.model}, reasoning: ${message.payload.effectiveSettings.reasoning_effort}`);
    }
    chips.forEach((text) => {
      const item = document.createElement("span");
      item.className = "source-chip";
      item.textContent = text;
      meta.appendChild(item);
    });
    if (meta.children.length) {
      card.appendChild(meta);
    }

    if (answer.warnings?.length) {
      const warnings = document.createElement("div");
      warnings.className = "ai-meta-list";
      answer.warnings.forEach((warning) => {
        const item = document.createElement("div");
        item.textContent = `Warning: ${warning}`;
        warnings.appendChild(item);
      });
      card.appendChild(warnings);
    }

    const citations = message.payload.citations || {};
    if (citations.web?.length || citations.files?.length) {
      const list = document.createElement("div");
      list.className = "ai-citation-list";
      citations.web?.forEach((citation) => {
        const item = document.createElement("div");
        item.append("Web: ", linkElement(citation.url, citation.title));
        list.appendChild(item);
      });
      citations.files?.forEach((citation) => {
        const item = document.createElement("div");
        item.textContent = `File search: ${citation.filename || citation.file_id || "context file"}`;
        list.appendChild(item);
      });
      card.appendChild(list);
    }

    elements.aiChatLog.appendChild(card);
  });

  elements.aiChatLog.scrollTop = elements.aiChatLog.scrollHeight;
}

async function askAi(question) {
  openAiPanel("chat");
  const prompt = (question || elements.aiQuestionInput.value).trim();
  if (!prompt) {
    setAiContextStatus("Ask a question first.");
    return;
  }
  if (!state.ai.sessionReady) {
    setAiSessionStatus("Connect AI before asking a question.");
    return;
  }
  if (!state.allRows.length) {
    setAiContextStatus("Run a comparison before asking a question.");
    return;
  }

  appendAiMessage("user", { question: prompt });
  elements.aiQuestionInput.value = "";
  setAiBusy(true);

  try {
    if (!state.ai.contextReady || state.ai.contextDirty) {
      await syncAiContext();
      setAiBusy(true);
    }
    setAiContextStatus("Asking AI...");
    const selected = currentSelectedRow();
    const result = await postJson("/api/ai/ask", {
      question: prompt,
      selectedParamName: selected ? selected.name : "",
      focusedParamNames: effectiveFocusNames(),
      settings: aiSettingsFromInputs()
    });
    appendAiMessage("assistant", result);
    setAiContextStatus("Answer complete. Sources are shown in the response when used.");
  } catch (error) {
    appendAiMessage("assistant", {
      answer: {
        answer_markdown: `AI request failed: ${error.message}`,
        referenced_params: [],
        focus_params_used: effectiveFocusNames(),
        warnings: [error.message],
        source_notes: ""
      },
      citations: { web: [], files: [] },
      effectiveSettings: aiSettingsFromInputs()
    });
    setAiContextStatus(`AI request failed: ${error.message}`);
  } finally {
    setAiBusy(false);
  }
}

async function cleanupAi() {
  if (!state.ai.sessionReady) {
    return;
  }
  setAiBusy(true);
  try {
    await postJson("/api/ai/cleanup", {});
  } catch (_error) {
    // Local state still gets cleared.
  } finally {
    state.ai.sessionReady = false;
    state.ai.contextReady = false;
    state.ai.contextDirty = true;
    state.ai.messages = [];
    renderAiMessages();
    setAiSessionStatus("API key not connected");
    setAiContextStatus("Run a comparison before preparing context.");
    setAiBusy(false);
  }
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function defaultExportStem() {
  const oldStem = state.files.oldName ? state.files.oldName.replace(/\.[^.]+$/, "") : "old";
  const newStem = state.files.newName ? state.files.newName.replace(/\.[^.]+$/, "") : "new";
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..+$/, "").replace("T", "_");
  return `arducopter_param_diff_${oldStem}_vs_${newStem}_${stamp}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!state.filteredRows.length) {
    setStatus("Nothing to export. Run a comparison and keep at least one row visible.");
    return;
  }

  const header = [
    "status",
    "name",
    "old_value",
    "new_value",
    "old_decoded",
    "new_decoded",
    "display_name",
    "units",
    "range",
    "description",
    "notes"
  ];

  const lines = [header.map(csvCell).join(",")];
  state.filteredRows.forEach((row) => {
    lines.push([
      row.status,
      row.name,
      row.oldValue,
      row.newValue,
      row.oldDecoded,
      row.newDecoded,
      row.displayName,
      row.units,
      row.allowedRange,
      row.description,
      row.notes
    ].map(csvCell).join(","));
  });

  downloadFile(`${defaultExportStem()}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
  setStatus("CSV export downloaded.");
}

function buildHtmlReport() {
  const rowsMarkup = state.filteredRows.map((row) => `
    <tr class="status-${escapeHtml(row.status)}">
      <td>${escapeHtml(row.status)}</td>
      <td><code>${escapeHtml(row.name)}</code></td>
      <td><code>${escapeHtml(row.oldValue)}</code></td>
      <td><code>${escapeHtml(row.newValue)}</code></td>
      <td>${escapeHtml(row.oldDecoded)}</td>
      <td>${escapeHtml(row.newDecoded)}</td>
      <td>${escapeHtml(row.displayName)}</td>
      <td>${escapeHtml(row.units)}</td>
      <td><code>${escapeHtml(row.allowedRange)}</code></td>
      <td>${escapeHtml(row.description)}</td>
      <td>${escapeHtml(row.notes)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArduPilot Param Compare Report</title>
  <style>
    body { font-family: "Segoe UI", sans-serif; margin: 24px; color: #10212e; }
    h1 { margin-bottom: 6px; }
    p { color: #385064; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
    th, td { border: 1px solid #d7e0e8; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #ecf2f7; position: sticky; top: 0; }
    tr.status-changed { background: #fff1bf; }
    tr.status-added { background: #ddf8e6; }
    tr.status-removed { background: #fde0e0; }
    tr.status-same { background: #eef3f7; }
    code { font-family: Consolas, monospace; }
  </style>
</head>
<body>
  <h1>ArduPilot Param Compare</h1>
  <p>Old file: ${escapeHtml(state.files.oldName || "old")}<br>
     New file: ${escapeHtml(state.files.newName || "new")}<br>
     Metadata: ${escapeHtml(state.metadataSource)}</p>
  <table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Parameter</th>
        <th>Old value</th>
        <th>New value</th>
        <th>Old decoded</th>
        <th>New decoded</th>
        <th>Display name</th>
        <th>Units</th>
        <th>Range</th>
        <th>Description</th>
        <th>Notes</th>
      </tr>
    </thead>
    <tbody>${rowsMarkup}</tbody>
  </table>
</body>
</html>`;
}

function exportHtml() {
  if (!state.filteredRows.length) {
    setStatus("Nothing to export. Run a comparison and keep at least one row visible.");
    return;
  }
  downloadFile(`${defaultExportStem()}.html`, buildHtmlReport(), "text/html;charset=utf-8");
  setStatus("HTML report downloaded.");
}

function selectRow(rowId) {
  const previousSelectedName = currentSelectedRow()?.name || "";
  state.selectedRowId = rowId;
  highlightSelectedRow();
  renderDetails(rowById(state.selectedRowId));
  renderFocusChips();

  const selectedName = currentSelectedRow()?.name || "";
  if (!state.focusedParamNames.size && previousSelectedName !== selectedName) {
    markAiContextDirty("Selected param changed. Prepare context before the next AI answer.");
  }
}

function handleTableClick(event) {
  const focusButton = event.target.closest("[data-focus-param]");
  if (focusButton) {
    event.stopPropagation();
    toggleFocusedParam(focusButton.dataset.focusParam);
    return;
  }
  const rowElement = event.target.closest("tr[data-row-id]");
  if (!rowElement) {
    return;
  }
  selectRow(rowElement.dataset.rowId);
}

function handleTableKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const rowElement = event.target.closest("tr[data-row-id]");
  if (!rowElement) {
    return;
  }
  event.preventDefault();
  selectRow(rowElement.dataset.rowId);
}

function handleTableMove(event) {
  const rowElement = event.target.closest("tr[data-row-id]");
  if (!rowElement) {
    hideTooltip();
    return;
  }
  const row = rowById(rowElement.dataset.rowId);
  if (!row) {
    hideTooltip();
    return;
  }
  state.hoveredRowId = row.id;
  showTooltip(row.description || `${row.name}: no description available.`, event.clientX, event.clientY);
}

function initializeEvents() {
  elements.compareButton.addEventListener("click", compareFiles);
  elements.resetVersionButton.addEventListener("click", () => {
    elements.versionRefInput.value = "";
    elements.metadataUrlInput.value = DEFAULT_METADATA_URL;
    setStatus("Version reset to latest published metadata.");
  });

  [
    elements.searchInput,
    elements.filterChanged,
    elements.filterAdded,
    elements.filterRemoved,
    elements.filterSame,
    elements.showSameInput,
    elements.sortByInput
  ].forEach((element) => {
    element.addEventListener("input", () => {
      if (element === elements.sortByInput) {
        state.allRows = sortRows(state.allRows, elements.sortByInput.value);
      }
      applyFilters();
    });
    element.addEventListener("change", () => {
      if (element === elements.sortByInput) {
        state.allRows = sortRows(state.allRows, elements.sortByInput.value);
      }
      applyFilters();
    });
  });

  elements.exportCsvButton.addEventListener("click", exportCsv);
  elements.exportHtmlButton.addEventListener("click", exportHtml);
  elements.focusVisibleChangedButton.addEventListener("click", () => {
    state.filteredRows
      .filter((row) => row.status === "changed")
      .forEach((row) => state.focusedParamNames.add(row.name));
    renderTable();
    markAiContextDirty("Focused visible changed params. Prepare AI context.");
  });
  elements.clearVisibleFocusButton.addEventListener("click", () => {
    state.filteredRows.forEach((row) => state.focusedParamNames.delete(row.name));
    renderTable();
    markAiContextDirty("Visible focus cleared. Prepare AI context.");
  });
  elements.toggleFocusSelectedButton.addEventListener("click", () => {
    const selected = currentSelectedRow();
    if (selected) {
      toggleFocusedParam(selected.name);
    }
  });
  elements.openAiButton.addEventListener("click", () => openAiPanel("chat"));
  elements.aiLauncherButton.addEventListener("click", () => openAiPanel("chat"));
  elements.closeAiDrawerButton.addEventListener("click", closeAiPanel);
  elements.aiDrawerBackdrop.addEventListener("click", closeAiPanel);
  elements.aiTabButtons.forEach((button) => {
    button.addEventListener("click", () => setAiTab(button.dataset.aiTab));
  });
  elements.aiChatConnectButton.addEventListener("click", () => setAiTab("setup"));
  elements.clearInspectorFocusButton.addEventListener("click", () => {
    state.focusedParamNames.clear();
    renderTable();
    markAiContextDirty("Focus cleared. Prepare AI context.");
  });
  elements.clearAllFocusButton.addEventListener("click", () => {
    state.focusedParamNames.clear();
    renderTable();
    markAiContextDirty("Focus cleared. Prepare AI context.");
  });
  elements.connectAiButton.addEventListener("click", connectAiSession);
  elements.prepareAiContextButton.addEventListener("click", () => {
    syncAiContext().catch(() => {});
  });
  elements.cleanupAiButton.addEventListener("click", cleanupAi);
  elements.askAiButton.addEventListener("click", () => askAi());
  elements.aiQuestionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      askAi();
    }
  });
  document.querySelectorAll(".quick-prompt").forEach((button) => {
    button.addEventListener("click", () => askAi(button.dataset.prompt || button.textContent));
  });
  [
    elements.aiModelInput,
    elements.aiReasoningInput,
    elements.aiVerbosityInput,
    elements.aiMaxTokensInput,
    elements.aiWebSearchInput,
    elements.aiWebContextInput,
    elements.aiLiveWebInput,
    elements.aiServiceTierInput,
    elements.aiTemperatureInput
  ].forEach((element) => {
    element.addEventListener("input", () => {
      state.ai.settings = aiSettingsFromInputs();
    });
    element.addEventListener("change", () => {
      state.ai.settings = aiSettingsFromInputs();
    });
  });
  elements.resultsBody.addEventListener("click", handleTableClick);
  elements.resultsBody.addEventListener("keydown", handleTableKeydown);
  elements.resultsBody.addEventListener("mousemove", handleTableMove);
  elements.resultsBody.addEventListener("mouseleave", hideTooltip);
  window.addEventListener("scroll", hideTooltip, { passive: true });
  window.addEventListener("resize", hideTooltip);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.ai.panelOpen) {
      closeAiPanel();
    }
  });
}

initializeEvents();
syncFilterAvailability();
clearDetails();
renderFocusChips();
renderAiMessages();
setAiTab("chat");
syncAiShellState();
setAiBusy(false);
