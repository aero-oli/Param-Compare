"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PORT = Number(process.env.PORT || 8000);
const SESSION_COOKIE = "param_compare_ai_session";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_CONTEXT_ROWS = 6000;
const MAX_METADATA_ENTRIES = 8000;
const DEFAULT_MODEL = "gpt-5.4-mini";

const sessions = new Map();

function createSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  header.split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index < 0) {
      return;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  });
  return cookies;
}

function sessionCookie(id) {
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastSeen > SESSION_MAX_AGE_MS) {
      clearOpenAIContext(session);
      sessions.delete(id);
    }
  }
}

function getSession(req) {
  cleanupExpiredSessions();
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!id) {
    return null;
  }
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "OpenAI session is not configured." });
    return;
  }
  req.aiSession = session;
  next();
}

async function openaiRequest(apiKey, pathName, options = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(options.headers || {})
  };
  let body = options.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(`${OPENAI_BASE_URL}${pathName}`, {
    method: options.method || "GET",
    headers,
    body
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "object" && payload && payload.error
      ? payload.error.message || JSON.stringify(payload.error)
      : String(payload || `HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function safeArray(value, limit) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, limit);
}

function normalizeName(value) {
  return String(value || "").trim();
}

function prefixForParam(name) {
  const normalized = normalizeName(name);
  const index = normalized.indexOf("_");
  if (index > 0) {
    return normalized.slice(0, index + 1);
  }
  return normalized.slice(0, 4);
}

function statusCounts(rows) {
  const counts = { changed: 0, added: 0, removed: 0, same: 0 };
  rows.forEach((row) => {
    if (counts[row.status] !== undefined) {
      counts[row.status] += 1;
    }
  });
  return counts;
}

function rowLine(row) {
  return [
    `- ${row.name}`,
    `status=${row.status || ""}`,
    `old=${row.oldValue || "<missing>"}`,
    `new=${row.newValue || "<missing>"}`,
    row.oldDecoded || row.newDecoded ? `decoded old=${row.oldDecoded || "-"} new=${row.newDecoded || "-"}` : "",
    row.units ? `units=${row.units}` : "",
    row.allowedRange ? `range=${row.allowedRange}` : "",
    row.notes ? `notes=${row.notes}` : "",
    row.description ? `description=${row.description}` : ""
  ].filter(Boolean).join("; ");
}

function metadataLine(meta) {
  return [
    `- ${meta.name}`,
    meta.displayName ? `display=${meta.displayName}` : "",
    meta.units ? `units=${meta.units}` : "",
    meta.low || meta.high ? `range=${meta.low || ""}..${meta.high || ""}` : "",
    meta.rebootRequired ? `reboot=${meta.rebootRequired}` : "",
    meta.values ? `values=${JSON.stringify(meta.values)}` : "",
    meta.bitmask ? `bitmask=${JSON.stringify(meta.bitmask)}` : "",
    meta.description ? `description=${meta.description}` : ""
  ].filter(Boolean).join("; ");
}

function buildFocusBundle(context) {
  const rows = safeArray(context.rows, MAX_CONTEXT_ROWS);
  const metadata = safeArray(context.metadataEntries, MAX_METADATA_ENTRIES);
  const rowByName = new Map(rows.map((row) => [row.name, row]));
  const metaByName = new Map(metadata.map((meta) => [meta.name, meta]));
  const focusNames = safeArray(context.focusedParamNames, 250)
    .map(normalizeName)
    .filter(Boolean);
  const effectiveFocus = focusNames.length
    ? focusNames
    : [normalizeName(context.selectedParamName)].filter(Boolean);
  const familyPrefixes = new Set(effectiveFocus.map(prefixForParam));
  const familyRows = rows.filter((row) => familyPrefixes.has(prefixForParam(row.name))).slice(0, 400);

  const lines = [
    "# Focused Parameters",
    "",
    effectiveFocus.length ? `Focused params: ${effectiveFocus.join(", ")}` : "No explicit focused params.",
    ""
  ];

  effectiveFocus.forEach((name) => {
    const row = rowByName.get(name);
    const meta = metaByName.get(name);
    lines.push(`## ${name}`);
    if (row) {
      lines.push(rowLine(row));
    }
    if (meta && (!row || meta.description !== row.description)) {
      lines.push(metadataLine(meta));
    }
    if (!row && !meta) {
      lines.push("- Not found in loaded comparison or metadata.");
    }
    lines.push("");
  });

  if (familyRows.length) {
    lines.push("## Nearby Family Parameters");
    familyRows.forEach((row) => lines.push(rowLine(row)));
  }

  return lines.join("\n");
}

function chunkLines(title, lines, size = 350) {
  const docs = [];
  for (let index = 0; index < lines.length; index += size) {
    docs.push({
      filename: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.floor(index / size) + 1}.md`,
      content: [`# ${title} ${Math.floor(index / size) + 1}`, "", ...lines.slice(index, index + size)].join("\n")
    });
  }
  return docs;
}

function buildContextDocuments(context) {
  const rows = safeArray(context.rows, MAX_CONTEXT_ROWS);
  const metadata = safeArray(context.metadataEntries, MAX_METADATA_ENTRIES);
  const counts = statusCounts(rows);
  const docs = [
    {
      filename: "comparison-overview.md",
      content: [
        "# ArduPilot Parameter Comparison Overview",
        "",
        `Old file: ${context.files?.oldName || "unknown"}`,
        `New file: ${context.files?.newName || "unknown"}`,
        `Firmware/version ref: ${context.versionRef || "not specified"}`,
        `Metadata source: ${context.metadataSource || "not specified"}`,
        `Rows: ${rows.length}`,
        `Changed: ${counts.changed}`,
        `Added: ${counts.added}`,
        `Removed: ${counts.removed}`,
        `Same: ${counts.same}`,
        `Selected parameter: ${context.selectedParamName || "none"}`,
        `Focused parameters: ${safeArray(context.focusedParamNames, 250).join(", ") || "none"}`
      ].join("\n")
    },
    {
      filename: "focused-parameters.md",
      content: buildFocusBundle(context)
    }
  ];

  docs.push(...chunkLines("Comparison Diff Rows", rows.map(rowLine), 450));

  const groups = new Map();
  metadata.forEach((meta) => {
    const prefix = prefixForParam(meta.name || "");
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
    }
    groups.get(prefix).push(metadataLine(meta));
  });

  for (const [prefix, lines] of groups.entries()) {
    docs.push(...chunkLines(`Metadata ${prefix || "Other"}`, lines, 350));
  }

  return docs;
}

function sanitizeSettings(raw = {}) {
  const allowedEffort = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  const allowedVerbosity = new Set(["low", "medium", "high"]);
  const allowedTier = new Set(["auto", "flex", "fast"]);
  const allowedSearchSize = new Set(["low", "medium", "high"]);
  const settings = {
    model: normalizeName(raw.model) || DEFAULT_MODEL,
    reasoning_effort: allowedEffort.has(raw.reasoning_effort) ? raw.reasoning_effort : "low",
    verbosity: allowedVerbosity.has(raw.verbosity) ? raw.verbosity : "medium",
    max_output_tokens: Number.isFinite(Number(raw.max_output_tokens))
      ? Math.min(12000, Math.max(600, Math.floor(Number(raw.max_output_tokens))))
      : 2400,
    service_tier: allowedTier.has(raw.service_tier) ? raw.service_tier : "auto",
    web_search_enabled: raw.web_search_enabled !== false,
    web_search_context_size: allowedSearchSize.has(raw.web_search_context_size) ? raw.web_search_context_size : "high",
    external_web_access: raw.external_web_access !== false,
    temperature: raw.temperature === "" || raw.temperature === null || raw.temperature === undefined
      ? null
      : Math.min(2, Math.max(0, Number(raw.temperature)))
  };
  if (!Number.isFinite(settings.temperature)) {
    settings.temperature = null;
  }
  if (settings.web_search_enabled && settings.reasoning_effort === "minimal") {
    settings.reasoning_effort = "low";
  }
  return settings;
}

function contextIndexes(context) {
  const rows = safeArray(context.rows, MAX_CONTEXT_ROWS);
  const metadata = safeArray(context.metadataEntries, MAX_METADATA_ENTRIES);
  const rowByName = new Map(rows.map((row) => [row.name, row]));
  const metaByName = new Map(metadata.map((meta) => [meta.name, meta]));
  return { rows, metadata, rowByName, metaByName };
}

function paramPayload(name, indexes) {
  const key = normalizeName(name);
  const row = indexes.rowByName.get(key) || null;
  const meta = indexes.metaByName.get(key) || null;
  if (!row && !meta) {
    return { found: false, name: key };
  }
  return { found: true, name: key, row, metadata: meta };
}

function executeTool(name, args, session, current = {}) {
  const context = session.context || {};
  const indexes = contextIndexes(context);
  const focused = safeArray(current.focusedParamNames, 250).filter(Boolean);
  const selected = normalizeName(current.selectedParamName || context.selectedParamName);

  if (name === "get_selected_param") {
    return selected ? paramPayload(selected, indexes) : { found: false, reason: "No selected parameter." };
  }
  if (name === "get_focused_params") {
    const names = focused.length ? focused : [selected].filter(Boolean);
    return { focused_param_names: names, params: names.map((paramName) => paramPayload(paramName, indexes)) };
  }
  if (name === "set_or_resolve_focus_candidates") {
    const query = normalizeName(args.query).toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(args.limit || 20)));
    const candidates = indexes.rows
      .filter((row) => row.name.toLowerCase().includes(query) || String(row.displayName || "").toLowerCase().includes(query))
      .slice(0, limit)
      .map((row) => ({ name: row.name, status: row.status, displayName: row.displayName }));
    return { query, candidates };
  }
  if (name === "get_param") {
    return paramPayload(args.name, indexes);
  }
  if (name === "search_params") {
    const query = normalizeName(args.query).toLowerCase();
    const status = normalizeName(args.status);
    const limit = Math.min(100, Math.max(1, Number(args.limit || 25)));
    const params = indexes.rows
      .filter((row) => !status || row.status === status)
      .filter((row) => {
        if (!query) {
          return true;
        }
        return [
          row.name,
          row.displayName,
          row.description,
          row.notes,
          row.oldDecoded,
          row.newDecoded
        ].join(" ").toLowerCase().includes(query);
      })
      .slice(0, limit);
    return { query, status: status || null, params };
  }
  if (name === "get_param_family") {
    const prefix = normalizeName(args.prefix || prefixForParam(args.name || selected));
    const limit = Math.min(200, Math.max(1, Number(args.limit || 80)));
    const params = indexes.rows.filter((row) => row.name.startsWith(prefix)).slice(0, limit);
    return { prefix, params };
  }
  if (name === "get_comparison_summary") {
    return {
      files: context.files || {},
      metadataSource: context.metadataSource || "",
      versionRef: context.versionRef || "",
      counts: statusCounts(indexes.rows),
      totalRows: indexes.rows.length,
      selectedParamName: selected || null,
      focusedParamNames: focused
    };
  }
  if (name === "get_changed_params") {
    const status = normalizeName(args.status || "changed");
    const limit = Math.min(300, Math.max(1, Number(args.limit || 100)));
    return {
      status,
      params: indexes.rows.filter((row) => row.status === status).slice(0, limit)
    };
  }
  return { error: `Unknown tool: ${name}` };
}

function functionTool(name, description, properties, required = []) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  };
}

function buildFunctionTools() {
  return [
    functionTool("get_selected_param", "Return the currently selected parameter row and metadata.", {}),
    functionTool("get_focused_params", "Return all parameters the user focused for this AI question.", {}),
    functionTool(
      "set_or_resolve_focus_candidates",
      "Resolve ambiguous user references to possible parameter names.",
      {
        query: { type: "string" },
        limit: { type: "number" }
      },
      ["query"]
    ),
    functionTool(
      "get_param",
      "Return one parameter by exact name from the loaded comparison and metadata.",
      { name: { type: "string" } },
      ["name"]
    ),
    functionTool(
      "search_params",
      "Search loaded parameters by name, label, description, decoded values, notes, and optional status.",
      {
        query: { type: "string" },
        status: { type: "string", enum: ["", "changed", "added", "removed", "same"] },
        limit: { type: "number" }
      },
      ["query"]
    ),
    functionTool(
      "get_param_family",
      "Return parameters in the same prefix family.",
      {
        name: { type: "string" },
        prefix: { type: "string" },
        limit: { type: "number" }
      }
    ),
    functionTool("get_comparison_summary", "Return comparison files, metadata source, counts, selected and focused params.", {}),
    functionTool(
      "get_changed_params",
      "Return params by change status.",
      {
        status: { type: "string", enum: ["changed", "added", "removed", "same"] },
        limit: { type: "number" }
      }
    )
  ];
}

function buildResponseTools(session, settings) {
  const tools = buildFunctionTools();
  if (settings.web_search_enabled) {
    tools.push({
      type: "web_search",
      search_context_size: settings.web_search_context_size,
      external_web_access: settings.external_web_access
    });
  }
  return tools;
}

function answerSchema() {
  return {
    type: "json_schema",
    name: "param_ai_answer",
    strict: true,
    schema: {
      type: "object",
      properties: {
        answer_markdown: { type: "string" },
        referenced_params: { type: "array", items: { type: "string" } },
        focus_params_used: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
        source_notes: { type: "string" }
      },
      required: ["answer_markdown", "referenced_params", "focus_params_used", "warnings", "source_notes"],
      additionalProperties: false
    }
  };
}

function buildInstructions(settings = {}) {
  return [
    "You are an ArduPilot Copter parameter assistant inside a parameter comparison app.",
    "Use loaded comparison data and loaded versioned metadata as authoritative for the user's files.",
    settings.web_search_enabled
      ? "Web search is enabled. Before answering parameter meaning, change impact, risk, troubleshooting, or related-parameter questions, use web search to ground the answer unless the user only asks to restate loaded old/new values."
      : "Web search is disabled. Say when an answer cannot be grounded beyond the loaded comparison and metadata.",
    "Use official ArduPilot docs, source, and autotest metadata as the strongest external sources.",
    "When searching the web, prefer ardupilot.org documentation, ArduPilot source on GitHub, and autotest parameter metadata before community sources.",
    "Use forums, user guides, GitHub issues, blog posts, and community material only as operational context when official or loaded data is not clear.",
    "When community sources conflict or are anecdotal, say so clearly.",
    "If the user asks about params outside the focused set, you may search loaded params and explain that you expanded beyond focus.",
    "Prefer concrete parameter names, old/new values, decoded values, units, ranges, reboot notes, and firmware/version context.",
    "Do not invent flight-safety certainty. Call out uncertainty and recommend checking official docs or performing controlled validation when appropriate.",
    "Return only JSON that matches the requested schema."
  ].join("\n");
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }
  const chunks = [];
  for (const item of response.output || []) {
    if (item.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractToolCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

function extractCitations(response) {
  const web = [];
  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const content of item.content || []) {
        for (const annotation of content.annotations || []) {
          if (annotation.type === "url_citation") {
            web.push({
              url: annotation.url,
              title: annotation.title || annotation.url
            });
          }
        }
      }
    }
    if (item.type === "web_search_call" && item.action?.sources) {
      item.action.sources.forEach((source) => {
        if (source.url) {
          web.push({ url: source.url, title: source.title || source.url });
        }
      });
    }
  }
  const seen = new Set();
  return {
    web: web.filter((item) => {
      const key = item.url || item.title;
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).slice(0, 20),
    files: []
  };
}

function extractWebSearchStatus(response, settings) {
  const calls = (response.output || []).filter((item) => item.type === "web_search_call");
  return {
    enabled: Boolean(settings.web_search_enabled),
    used: calls.length > 0,
    callCount: calls.length
  };
}

function parseAnswerPayload(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return {
      answer_markdown: text || "No answer was returned.",
      referenced_params: [],
      focus_params_used: [],
      warnings: ["The model response was not valid structured JSON, so it was displayed as plain text."],
      source_notes: ""
    };
  }
}

function responseBody(question, session, settings, current, previousResponseId, toolOutputs) {
  const input = toolOutputs || [{
    role: "user",
    content: [{
      type: "input_text",
      text: [
        question,
        "",
        `Selected parameter: ${current.selectedParamName || "none"}`,
        `Focused parameters: ${safeArray(current.focusedParamNames, 250).join(", ") || "none"}`,
        `Firmware/version ref: ${session.context?.versionRef || "not specified"}`,
        `Metadata source: ${session.context?.metadataSource || "not specified"}`,
        settings.web_search_enabled
          ? "Grounding directive: use web search for current official or source-backed context before finalizing the answer."
          : "Grounding directive: web search is off; rely only on loaded comparison and metadata."
      ].join("\n")
    }]
  }];
  const tools = buildResponseTools(session, settings);
  const shouldRequireInitialTool = settings.web_search_enabled && !toolOutputs;

  const body = {
    model: settings.model,
    instructions: buildInstructions(settings),
    input,
    tools,
    tool_choice: shouldRequireInitialTool ? "required" : "auto",
    max_output_tokens: settings.max_output_tokens,
    text: {
      format: answerSchema(),
      verbosity: settings.verbosity
    },
    store: true,
    include: ["web_search_call.action.sources"]
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }
  if (settings.reasoning_effort !== "minimal") {
    body.reasoning = { effort: settings.reasoning_effort };
  } else {
    body.reasoning = { effort: "minimal" };
  }
  if (settings.service_tier !== "auto") {
    body.service_tier = settings.service_tier;
  }
  if (settings.temperature !== null) {
    body.temperature = settings.temperature;
  }
  return body;
}

async function createResponseWithFallback(apiKey, body) {
  const attempts = [
    body,
    { ...body, temperature: undefined },
    { ...body, temperature: undefined, service_tier: undefined },
    { ...body, temperature: undefined, service_tier: undefined, include: undefined },
    {
      ...body,
      temperature: undefined,
      service_tier: undefined,
      include: undefined,
      reasoning: undefined
    }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const cleaned = JSON.parse(JSON.stringify(attempt));
    try {
      return await openaiRequest(apiKey, "/responses", {
        method: "POST",
        body: cleaned
      });
    } catch (error) {
      lastError = error;
      if (error.status && error.status >= 500) {
        break;
      }
    }
  }
  throw lastError;
}

function previousResponseIdForAsk(session, isolated = false) {
  return isolated ? null : session.previousResponseId || null;
}

function rememberAskResponseId(session, responseId, isolated = false) {
  if (!isolated) {
    session.previousResponseId = responseId;
  }
}

async function runAsk(session, question, rawSettings, current, options = {}) {
  const settings = sanitizeSettings(rawSettings);
  const isolated = options.isolated === true;
  let previousResponseId = previousResponseIdForAsk(session, isolated);
  let response = await createResponseWithFallback(
    session.apiKey,
    responseBody(question, session, settings, current, previousResponseId, null)
  );

  for (let depth = 0; depth < 5; depth += 1) {
    const calls = extractToolCalls(response);
    if (!calls.length) {
      break;
    }

    const outputs = calls.map((call) => {
      let args = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch (_error) {
        args = {};
      }
      return {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(executeTool(call.name, args, session, current))
      };
    });

    previousResponseId = response.id;
    response = await createResponseWithFallback(
      session.apiKey,
      responseBody(question, session, settings, current, previousResponseId, outputs)
    );
  }

  rememberAskResponseId(session, response.id, isolated);
  const text = extractOutputText(response);
  return {
    answer: parseAnswerPayload(text),
    citations: extractCitations(response),
    webSearch: extractWebSearchStatus(response, settings),
    effectiveSettings: settings,
    responseId: response.id
  };
}

function clearOpenAIContext(session) {
  session.context = null;
  session.previousResponseId = null;
}

function configureContext(session, context) {
  const cleanContext = {
    ...context,
    rows: safeArray(context.rows, MAX_CONTEXT_ROWS),
    metadataEntries: safeArray(context.metadataEntries, MAX_METADATA_ENTRIES),
    focusedParamNames: safeArray(context.focusedParamNames, 250).map(normalizeName).filter(Boolean),
    selectedParamName: normalizeName(context.selectedParamName)
  };
  session.context = cleanContext;
  session.previousResponseId = null;
  return {
    contextReady: true,
    rowCount: cleanContext.rows.length,
    metadataEntryCount: cleanContext.metadataEntries.length
  };
}

async function validateApiKey(apiKey) {
  const models = await openaiRequest(apiKey, "/models");
  const modelIds = (models.data || [])
    .map((model) => model.id)
    .filter((id) => /^(gpt|o\d|chatgpt|computer-use)/.test(id))
    .sort();
  return modelIds;
}

function createApp(options = {}) {
  const validateApiKeyImpl = options.validateApiKey || validateApiKey;
  const serverApiKey = options.openAiApiKey !== undefined ? options.openAiApiKey : OPENAI_API_KEY;
  const desktopKeyStore = options.desktopKeyStore || null;
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/openai/status", (_req, res) => {
    res.json({
      serverKeyAvailable: Boolean(serverApiKey),
      desktopKeyStorageAvailable: Boolean(desktopKeyStore?.isAvailable()),
      desktopStoredKeyAvailable: Boolean(desktopKeyStore?.hasKey())
    });
  });

  app.post("/api/desktop/openai-key/clear", (_req, res) => {
    if (!desktopKeyStore) {
      res.status(404).json({ error: "Desktop key storage is not available." });
      return;
    }
    try {
      desktopKeyStore.clearKey();
      res.json({ ok: true, desktopStoredKeyAvailable: false });
    } catch (error) {
      res.status(500).json({ error: error.message || "Could not clear the saved API key." });
    }
  });

  app.post("/api/openai/session", async (req, res) => {
    const providedApiKey = normalizeName(req.body?.apiKey);
    const wantsDesktopStoredKey = req.body?.useDesktopStoredKey === true;
    const wantsServerKey = req.body?.useServerKey === true || (!providedApiKey && !wantsDesktopStoredKey);
    const apiKey = wantsDesktopStoredKey
      ? normalizeName(desktopKeyStore?.getKey())
      : wantsServerKey
        ? normalizeName(serverApiKey)
        : providedApiKey;
    const source = wantsDesktopStoredKey ? "desktop" : wantsServerKey ? "environment" : "manual";
    if (!apiKey) {
      res.status(400).json({ error: "Enter an OpenAI API key, use a saved desktop key, or configure OPENAI_API_KEY on the server." });
      return;
    }
    try {
      const models = await validateApiKeyImpl(apiKey);
      if (!wantsDesktopStoredKey && req.body?.rememberApiKey === true && desktopKeyStore) {
        desktopKeyStore.setKey(apiKey);
      }
      const id = createSessionId();
      sessions.set(id, {
        id,
        apiKey,
        source,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        context: null,
        previousResponseId: null
      });
      res.setHeader("Set-Cookie", sessionCookie(id));
      res.json({
        ok: true,
        source,
        models,
        desktopStoredKeyAvailable: Boolean(desktopKeyStore?.hasKey()),
        recommendedModel: models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models.find((model) => model.startsWith("gpt-5")) || DEFAULT_MODEL
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || "Could not validate API key." });
    }
  });

  app.post("/api/ai/context", requireSession, async (req, res) => {
    try {
      const result = configureContext(req.aiSession, req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || "Could not configure AI context." });
    }
  });

  app.post("/api/ai/ask", requireSession, async (req, res) => {
    const question = normalizeName(req.body?.question);
    if (!question) {
      res.status(400).json({ error: "Ask a question first." });
      return;
    }
    if (!req.aiSession.context) {
      res.status(400).json({ error: "Run a comparison and prepare AI context before asking." });
      return;
    }
    try {
      const result = await runAsk(req.aiSession, question, req.body?.settings || {}, {
        selectedParamName: req.body?.selectedParamName || "",
        focusedParamNames: safeArray(req.body?.focusedParamNames, 250)
      }, {
        isolated: req.body?.isolated === true
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || "AI request failed." });
    }
  });

  app.post("/api/ai/cleanup", requireSession, async (req, res) => {
    clearOpenAIContext(req.aiSession);
    res.setHeader("Set-Cookie", clearSessionCookie());
    sessions.delete(req.aiSession.id);
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });
  ["/index.html", "/app.js", "/styles.css"].forEach((assetPath) => {
    app.get(assetPath, (_req, res) => {
      res.sendFile(path.join(__dirname, assetPath.slice(1)));
    });
  });
  app.get("/vendor/marked.umd.js", (_req, res) => {
    res.sendFile(path.join(__dirname, "node_modules", "marked", "lib", "marked.umd.js"));
  });
  return app;
}

if (require.main === module) {
  createApp().listen(PORT, () => {
    console.log(`Param Compare running at http://127.0.0.1:${PORT}/`);
  });
}

module.exports = {
  buildContextDocuments,
  buildFocusBundle,
  createApp,
  executeTool,
  extractWebSearchStatus,
  previousResponseIdForAsk,
  rememberAskResponseId,
  paramPayload,
  prefixForParam,
  sanitizeSettings,
  statusCounts
};
