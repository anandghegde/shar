import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { pickOption } from "../src/picker.js";

const options = [
  { name: "foundry", label: "Foundry", value: "F" },
  { name: "glm", label: "Surplus GLM 5.3", value: "G" },
  { name: "sol", label: "Surplus GPT-6.1 Sol", value: "S" }
];

function startPicker() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk;
  });

  const result = pickOption({ title: "Launch:", options, input, output });
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
