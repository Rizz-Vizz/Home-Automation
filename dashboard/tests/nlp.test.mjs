import assert from "node:assert/strict";
import test from "node:test";
import { intentFromLlm, parseStructuredIntent } from "../src/utils/nlp.js";

test("The three voice examples from the Home Automation brief work verbatim", () => {
  const lights = parseStructuredIntent("Turn off all lights.");
  assert.equal(lights.cmd, "lights_off");
  assert.equal(lights.requiresConfirmation, false);

  const ac = parseStructuredIntent("Set bedroom AC to 23 degrees.");
  assert.equal(ac.cmd, "ac_config");
  assert.equal(JSON.parse(ac.arg).targetC, 23);

  const saver = parseStructuredIntent("Activate energy saver mode.");
  assert.equal(saver.cmd, "energy_saver");
});

test("Scope is respected: lights are not devices, rooms are not ignored", () => {
  assert.equal(parseStructuredIntent("Turn off all devices").cmd, "all_off");
  assert.equal(parseStructuredIntent("Turn off everything").cmd, "all_off");
  assert.equal(parseStructuredIntent("Turn off all lights").cmd, "lights_off");
  assert.equal(parseStructuredIntent("turn on the bedroom light").cmd, "lamp_bed");
  assert.equal(parseStructuredIntent("set living room light to 40%").arg, "40");
  assert.equal(parseStructuredIntent("turn on the kitchen light").kind, "unsupported");
  assert.equal(parseStructuredIntent("set kitchen AC to 22").kind, "unsupported");
});

test("Risky commands ask for confirmation, safety words map to the real emergency path", () => {
  assert.equal(parseStructuredIntent("Emergency shutdown").cmd, "emergency_stop");
  assert.equal(parseStructuredIntent("Emergency shutdown").requiresConfirmation, true);
  assert.equal(parseStructuredIntent("Arm away security mode").requiresConfirmation, true);
  const priv = parseStructuredIntent("Turn on privacy mode");
  assert.equal(priv.arg, "on");
  assert.equal(priv.requiresConfirmation, true);
  assert.equal(parseStructuredIntent("Activate night mode").cmd, "night_mode");
  assert.equal(parseStructuredIntent("Turn on wireless power pad").cmd, "pad_tx");
  assert.equal(parseStructuredIntent("Why did energy spike?").kind, "query");
  assert.equal(parseStructuredIntent("blah blah"), null);
});

test("Gateway LLM suggestion is mapped, never trusted blindly", () => {
  assert.equal(intentFromLlm({ ok: false }), null);
  const i = intentFromLlm({ ok: true, intent: { cmd: "away_arm", arg: "", label: "Arm" } });
  assert.equal(i.requiresConfirmation, true);
  assert.equal(i.source, "llm");
});
