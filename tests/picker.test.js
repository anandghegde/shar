import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { pickOption } from "../src/picker.js";

const options = [
  { name: "foundry", label: "Foundry", value: "F" },
  { name: "glm", label: "Surplus GLM 5.3", value: "G" },
  { name: "sol", label: "Surplus GPT-6.1 Sol", value: "S" }
];

function startPicker(extra = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk;
  });

  const result = pickOption({ title: "Launch:", options, input, output, ...extra });
  const waitFor = async (text) => {
    for (let i = 0; i < 200 && !written.includes(text); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(written.includes(text), `expected output to include ${text}: ${written}`);
  };
  return { input, result, waitFor, written: () => written };
}

test("pickOption lists numbered options and returns the one chosen by number", async () => {
  const picker = startPicker();
  await picker.waitFor("Choose");

  assert.match(picker.written(), /1\) foundry {2}Foundry/);
  assert.match(picker.written(), /2\) glm {6}Surplus GLM 5\.3/);

  picker.input.write("2\n");
  assert.equal(await picker.result, "G");
});

test("pickOption accepts an option name", async () => {
  const picker = startPicker();
  await picker.waitFor("Choose");

  picker.input.write("sol\n");
  assert.equal(await picker.result, "S");
});

test("pickOption re-prompts on an unknown choice", async () => {
  const picker = startPicker();
  await picker.waitFor("Choose");
  picker.input.write("9\n");
  await picker.waitFor("Unknown choice: 9");

  picker.input.write("1\n");
  assert.equal(await picker.result, "F");
});

test("pickOption returns null on q and on end of input", async () => {
  const quit = startPicker();
  await quit.waitFor("Choose");
  quit.input.write("q\n");
  assert.equal(await quit.result, null);

  const eof = startPicker();
  await eof.waitFor("Choose");
  eof.input.end();
  assert.equal(await eof.result, null);
});

test("pickOption refreshes an option on r<N> or r <name> and redraws the list", async () => {
  const refreshed = [];
  const picker = startPicker({
    onRefresh: async (value) => {
      refreshed.push(value);
      return options.map((option) => (option.value === value ? { ...option, label: `${option.label} fresh` } : option));
    }
  });
  await picker.waitFor("r<N> refresh");

  picker.input.write("r2\n");
  await picker.waitFor("Surplus GLM 5.3 fresh");
  picker.input.write("r sol\n");
  await picker.waitFor("Surplus GPT-6.1 Sol fresh");
  picker.input.write("2\n");

  assert.equal(await picker.result, "G");
  assert.deepEqual(refreshed, ["G", "S"]);
});

test("pickOption treats r<N> as unknown without a refresh handler", async () => {
  const picker = startPicker();
  await picker.waitFor("Choose");
  assert.doesNotMatch(picker.written(), /refresh/);

  picker.input.write("r2\n");
  await picker.waitFor("Unknown choice: r2");
  picker.input.write("q\n");
  assert.equal(await picker.result, null);
});
