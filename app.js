"use strict";

const DEFAULT_METADATA_URL = "https://autotest.ardupilot.org/Parameters/ArduCopter/apm.pdef.json";
const DEFAULT_VERSIONED_METADATA_URL_TEMPLATE =
  "https://autotest.ardupilot.org/Parameters/versioned/Copter/{version}/apm.pdef.json";
const STATUS_ORDER = { changed: 0, added: 1, removed: 2, same: 3 };
const FLOAT_REL_TOL = 1e-9;
const FLOAT_ABS_TOL = 1e-12;
const CACHE_PREFIX = "ardupilot-param-compare-cache:";
const TOOLTIP_OFFSET = 16;

const state = {
  allRows: [],
  filteredRows: [],
  metadata: new Map(),
  metadataSource: "Not loaded yet",
  selectedRowId: "",
  hoveredRowId: "",
  files: {
    oldName: "",
    newName: ""
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
  tooltip: document.getElementById("tooltip")
};

function setStatus(text) {
  elements.statusText.textContent = text;
}

function setMetadataStatus(text) {
  elements.metadataStatusText.textContent = text;
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
      const statusDelta = (STATUS_ORDER[a.status] || 99) - (STATUS_ORDER[b.status] || 99);
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

function updateSummary() {
  const counts = statusCounts(state.allRows);
  elements.summaryChanged.textContent = String(counts.changed);
  elements.summaryAdded.textContent = String(counts.added);
  elements.summaryRemoved.textContent = String(counts.removed);
  elements.summarySame.textContent = String(counts.same);
  elements.summaryShown.textContent = String(state.filteredRows.length);
}

function clearDetails() {
  elements.detailName.textContent = "";
  elements.detailStatus.textContent = "";
  elements.detailOldValue.textContent = "";
  elements.detailNewValue.textContent = "";
  elements.detailDisplayName.textContent = "";
  elements.detailUnits.textContent = "";
  elements.detailRange.textContent = "";
  elements.detailDecoded.textContent = "";
  elements.detailNotes.textContent = "";
  elements.detailDescription.textContent = "Hover or select a parameter row to inspect it.";
}

function renderDetails(row) {
  if (!row) {
    clearDetails();
    return;
  }
  elements.detailName.textContent = row.name;
  elements.detailStatus.textContent = row.status;
  elements.detailOldValue.textContent = row.oldValue;
  elements.detailNewValue.textContent = row.newValue;
  elements.detailDisplayName.textContent = row.displayName;
  elements.detailUnits.textContent = row.units;
  elements.detailRange.textContent = row.allowedRange;
  elements.detailDecoded.textContent = [row.oldDecoded ? `Old: ${row.oldDecoded}` : "", row.newDecoded ? `New: ${row.newDecoded}` : ""]
    .filter(Boolean)
    .join(" | ");
  elements.detailNotes.textContent = row.notes;
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

function renderTable() {
  elements.resultsBody.innerHTML = "";
  if (!state.filteredRows.length) {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "empty-row";
    emptyRow.innerHTML = "<td colspan=\"10\">No rows match the current filters.</td>";
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
    tr.dataset.rowId = row.id;
    tr.innerHTML = `
      <td>${escapeHtml(row.status)}</td>
      <td class="param-name">${escapeHtml(row.name)}</td>
      <td class="mono">${escapeHtml(row.oldValue)}</td>
      <td class="mono">${escapeHtml(row.newValue)}</td>
      <td>${escapeHtml(row.oldDecoded)}</td>
      <td>${escapeHtml(row.newDecoded)}</td>
      <td>${escapeHtml(row.displayName)}</td>
      <td>${escapeHtml(row.units)}</td>
      <td class="mono">${escapeHtml(row.allowedRange)}</td>
      <td>${escapeHtml(row.notes)}</td>
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
}

function highlightSelectedRow() {
  elements.resultsBody.querySelectorAll("tr").forEach((tr) => {
    tr.classList.toggle("is-selected", tr.dataset.rowId === state.selectedRowId);
  });
}

function applyFilters() {
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
    applyFilters();
    setStatus(`Comparison complete. Loaded ${state.allRows.length} rows.`);
  } catch (error) {
    console.error(error);
    setStatus(`Comparison failed: ${error.message}`);
    setMetadataStatus("Metadata load failed");
  } finally {
    elements.compareButton.disabled = false;
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

function handleTableClick(event) {
  const rowElement = event.target.closest("tr[data-row-id]");
  if (!rowElement) {
    return;
  }
  state.selectedRowId = rowElement.dataset.rowId;
  highlightSelectedRow();
  renderDetails(rowById(state.selectedRowId));
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
  elements.resultsBody.addEventListener("click", handleTableClick);
  elements.resultsBody.addEventListener("mousemove", handleTableMove);
  elements.resultsBody.addEventListener("mouseleave", hideTooltip);
  window.addEventListener("scroll", hideTooltip, { passive: true });
  window.addEventListener("resize", hideTooltip);
}

initializeEvents();
clearDetails();
