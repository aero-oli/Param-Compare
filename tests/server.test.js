"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildContextDocuments,
  createApp,
  executeTool,
  extractWebSearchStatus,
  previousResponseIdForAsk,
  prefixForParam,
  rememberAskResponseId,
  sanitizeSettings,
  statusCounts
} = require("../server");

const sampleRows = [
  {
    name: "ATC_RAT_RLL_P",
    status: "changed",
    oldValue: "0.12",
    newValue: "0.14",
    displayName: "Rate Roll P",
    units: "",
    allowedRange: "0.01 .. 0.5",
    oldDecoded: "",
    newDecoded: "",
    description: "Roll rate P gain",
    notes: ""
  },
  {
    name: "ATC_RAT_RLL_I",
    status: "same",
    oldValue: "0.12",
    newValue: "0.12",
    displayName: "Rate Roll I",
    units: "",
    allowedRange: "0.01 .. 0.5",
    oldDecoded: "",
    newDecoded: "",
    description: "Roll rate I gain",
    notes: ""
  },
  {
    name: "BATT_LOW_VOLT",
    status: "added",
    oldValue: "",
    newValue: "10.5",
    displayName: "Battery low voltage",
    units: "V",
    allowedRange: "0 .. 50",
    oldDecoded: "",
    newDecoded: "",
    description: "Low battery threshold",
    notes: "reboot"
  }
];

const sampleMetadata = sampleRows.map((row) => ({
  name: row.name,
  displayName: row.displayName,
  description: row.description,
  units: row.units,
  low: row.allowedRange.split(" .. ")[0] || "",
  high: row.allowedRange.split(" .. ")[1] || "",
  values: null,
  bitmask: null,
  rebootRequired: row.notes
}));

async function withTestServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("statusCounts counts comparison statuses", () => {
  assert.deepEqual(statusCounts(sampleRows), {
    changed: 1,
    added: 1,
    removed: 0,
    same: 1
  });
});

test("prefixForParam returns parameter family prefix", () => {
  assert.equal(prefixForParam("ATC_RAT_RLL_P"), "ATC_");
  assert.equal(prefixForParam("FRAME"), "FRAM");
});

test("sanitizeSettings clamps and defaults AI settings", () => {
  const settings = sanitizeSettings({
    model: "",
    reasoning_effort: "extreme",
    verbosity: "chatty",
    max_output_tokens: 999999,
    service_tier: "invalid",
    web_search_enabled: false,
    web_search_context_size: "huge",
    external_web_access: false,
    temperature: 9
  });

  assert.equal(settings.model, "gpt-5.4-mini");
  assert.equal(settings.reasoning_effort, "low");
  assert.equal(settings.verbosity, "medium");
  assert.equal(settings.max_output_tokens, 12000);
  assert.equal(settings.service_tier, "auto");
  assert.equal(settings.web_search_enabled, false);
  assert.equal(settings.web_search_context_size, "medium");
  assert.equal(settings.external_web_access, false);
  assert.equal(settings.temperature, 2);
});

test("buildContextDocuments includes focus and diff documents", () => {
  const docs = buildContextDocuments({
    rows: sampleRows,
    metadataEntries: sampleMetadata,
    metadataSource: "test metadata",
    versionRef: "4.5.7",
    files: { oldName: "old.param", newName: "new.param" },
    selectedParamName: "ATC_RAT_RLL_P",
    focusedParamNames: ["ATC_RAT_RLL_P", "BATT_LOW_VOLT"]
  });

  assert.ok(docs.some((doc) => doc.filename === "comparison-overview.md"));
  const focusDoc = docs.find((doc) => doc.filename === "focused-parameters.md");
  assert.ok(focusDoc.content.includes("ATC_RAT_RLL_P"));
  assert.ok(focusDoc.content.includes("BATT_LOW_VOLT"));
  assert.ok(docs.some((doc) => doc.filename.startsWith("comparison-diff-rows")));
});

test("executeTool returns selected, focused, family, and changed params", () => {
  const session = {
    context: {
      rows: sampleRows,
      metadataEntries: sampleMetadata,
      selectedParamName: "ATC_RAT_RLL_P"
    }
  };

  assert.equal(executeTool("get_selected_param", {}, session, {}).name, "ATC_RAT_RLL_P");
  assert.deepEqual(
    executeTool("get_focused_params", {}, session, { focusedParamNames: ["BATT_LOW_VOLT"] }).focused_param_names,
    ["BATT_LOW_VOLT"]
  );
  assert.equal(executeTool("get_param_family", { name: "ATC_RAT_RLL_P" }, session, {}).params.length, 2);
  assert.equal(executeTool("get_changed_params", { status: "changed" }, session, {}).params[0].name, "ATC_RAT_RLL_P");
});

test("extractWebSearchStatus reports enabled and used state", () => {
  assert.deepEqual(
    extractWebSearchStatus({ output: [{ type: "web_search_call" }] }, { web_search_enabled: true }),
    { enabled: true, used: true, callCount: 1 }
  );
  assert.deepEqual(
    extractWebSearchStatus({ output: [] }, { web_search_enabled: true }),
    { enabled: true, used: false, callCount: 0 }
  );
  assert.deepEqual(
    extractWebSearchStatus({ output: [] }, { web_search_enabled: false }),
    { enabled: false, used: false, callCount: 0 }
  );
});

test("isolated asks do not consume or update conversation response state", () => {
  const session = { previousResponseId: "resp_previous" };

  assert.equal(previousResponseIdForAsk(session, false), "resp_previous");
  assert.equal(previousResponseIdForAsk(session, true), null);

  rememberAskResponseId(session, "resp_inline", true);
  assert.equal(session.previousResponseId, "resp_previous");

  rememberAskResponseId(session, "resp_chat", false);
  assert.equal(session.previousResponseId, "resp_chat");
});

test("OpenAI status reports when a server API key is available", async () => {
  const app = createApp({
    openAiApiKey: "sk-test-server",
    validateApiKey: async () => ["gpt-5.4-mini"]
  });

  await withTestServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/openai/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      serverKeyAvailable: true,
      desktopKeyStorageAvailable: false,
      desktopStoredKeyAvailable: false
    });
  });
});

test("OpenAI session can use the server environment key", async () => {
  const app = createApp({
    openAiApiKey: "sk-test-server",
    validateApiKey: async (apiKey) => {
      assert.equal(apiKey, "sk-test-server");
      return ["gpt-5.4-mini", "gpt-5.4"];
    }
  });

  await withTestServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/openai/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useServerKey: true })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.source, "environment");
    assert.equal(body.desktopStoredKeyAvailable, false);
    assert.equal(body.recommendedModel, "gpt-5.4-mini");
    assert.match(response.headers.get("set-cookie"), /param_compare_ai_session=/);
  });
});

test("OpenAI session can save and use a desktop stored key", async () => {
  let savedKey = "";
  const desktopKeyStore = {
    clearKey: () => {
      savedKey = "";
    },
    getKey: () => savedKey,
    hasKey: () => Boolean(savedKey),
    isAvailable: () => true,
    setKey: (apiKey) => {
      savedKey = apiKey;
    }
  };
  const seenKeys = [];
  const app = createApp({
    openAiApiKey: "",
    desktopKeyStore,
    validateApiKey: async (apiKey) => {
      seenKeys.push(apiKey);
      return ["gpt-5.4-mini"];
    }
  });

  await withTestServer(app, async (baseUrl) => {
    const initialStatus = await fetch(`${baseUrl}/api/openai/status`);
    assert.deepEqual(await initialStatus.json(), {
      serverKeyAvailable: false,
      desktopKeyStorageAvailable: true,
      desktopStoredKeyAvailable: false
    });

    const saveResponse = await fetch(`${baseUrl}/api/openai/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-desktop", rememberApiKey: true })
    });
    const saveBody = await saveResponse.json();
    assert.equal(saveResponse.status, 200);
    assert.equal(saveBody.source, "manual");
    assert.equal(saveBody.desktopStoredKeyAvailable, true);

    const storedResponse = await fetch(`${baseUrl}/api/openai/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useDesktopStoredKey: true })
    });
    const storedBody = await storedResponse.json();
    assert.equal(storedResponse.status, 200);
    assert.equal(storedBody.source, "desktop");
    assert.deepEqual(seenKeys, ["sk-test-desktop", "sk-test-desktop"]);

    const clearResponse = await fetch(`${baseUrl}/api/desktop/openai-key/clear`, {
      method: "POST"
    });
    assert.equal(clearResponse.status, 200);
    assert.equal(savedKey, "");
  });
});

test("OpenAI session still accepts a pasted temporary key and cleanup clears it", async () => {
  const app = createApp({
    openAiApiKey: "",
    validateApiKey: async (apiKey) => {
      assert.equal(apiKey, "sk-test-manual");
      return ["gpt-5.4-mini"];
    }
  });

  await withTestServer(app, async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/openai/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-manual" })
    });
    const sessionCookie = sessionResponse.headers.get("set-cookie").split(";")[0];
    const sessionBody = await sessionResponse.json();

    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionBody.source, "manual");

    const cleanupResponse = await fetch(`${baseUrl}/api/ai/cleanup`, {
      method: "POST",
      headers: { Cookie: sessionCookie }
    });
    assert.equal(cleanupResponse.status, 200);

    const secondCleanup = await fetch(`${baseUrl}/api/ai/cleanup`, {
      method: "POST",
      headers: { Cookie: sessionCookie }
    });
    assert.equal(secondCleanup.status, 401);
  });
});
