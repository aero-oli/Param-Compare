"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildContextDocuments,
  executeTool,
  prefixForParam,
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
