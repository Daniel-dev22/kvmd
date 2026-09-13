// The compact layout's native typing bar: the phone's own keyboard drives the
// host. Characters go through the server's keymap; Backspace and Enter go out
// as ordinary key events.

import test from "node:test";
import assert from "node:assert/strict";
import {read, jsFiles} from "./helpers.mjs";
import {diffTyped, makePrintQueue} from "../../web/share/js/kvm/typing.js";

test("appending text types only what is new", () => {
	assert.deepEqual(diffTyped("", "h"), {"backspaces": 0, "added": "h"});
	assert.deepEqual(diffTyped("hel", "hell"), {"backspaces": 0, "added": "l"});
	// A swipe or a dictation drops a whole word in at once.
	assert.deepEqual(diffTyped("", "hello"), {"backspaces": 0, "added": "hello"});
});

test("erasing at the end becomes backspaces, not retyping", () => {
	assert.deepEqual(diffTyped("hello", "hell"), {"backspaces": 1, "added": ""});
	assert.deepEqual(diffTyped("hello", "he"), {"backspaces": 3, "added": ""});
	assert.deepEqual(diffTyped("hello", ""), {"backspaces": 5, "added": ""});
});

test("a correction erases only back to the divergence", () => {
	// Autocorrect turning "teh" into "the" must not retype the whole field.
	assert.deepEqual(diffTyped("teh", "the"), {"backspaces": 2, "added": "he"});
});

test("no change types nothing", () => {
	assert.deepEqual(diffTyped("hello", "hello"), {"backspaces": 0, "added": ""});
	assert.deepEqual(diffTyped("", ""), {"backspaces": 0, "added": ""});
});

test("non-ASCII is carried through untouched", () => {
	// The server owns the keymap, so the browser must not try to interpret it.
	assert.deepEqual(diffTyped("", "é"), {"backspaces": 0, "added": "é"});
	assert.deepEqual(diffTyped("", "こんにちは"), {"backspaces": 0, "added": "こんにちは"});
	assert.deepEqual(diffTyped("こんにちは", "こんにち"), {"backspaces": 1, "added": ""});
});

// ---- the queue ----

function fakeTransport() {
	const inflight = [];
	const sent = [];
	return {
		"post": (text, keymap, done) => {
			inflight.push({text, keymap, done});
			sent.push(text);
		},
		"sent": sent,
		"inflight": inflight,
		"settle": (ok = true, info = null) => inflight.shift().done(ok, info),
	};
}

test("only one request is ever in flight", () => {
	const t = fakeTransport();
	const q = makePrintQueue({"post": t.post, "getKeymap": () => "en-us"});
	q.push("a");
	q.push("b");
	q.push("c");
	assert.equal(t.inflight.length, 1, "a second request went out before the first came back");
	assert.deepEqual(t.sent, ["a"]);
});

test("keystrokes typed during a request are coalesced into the next one", () => {
	const t = fakeTransport();
	const q = makePrintQueue({"post": t.post, "getKeymap": () => "en-us"});
	q.push("a");
	q.push("b");
	q.push("c");
	t.settle();
	// Two overlapping POSTs could arrive out of order and scramble the text,
	// so "bc" waits and goes as one.
	assert.deepEqual(t.sent, ["a", "bc"]);
	t.settle();
	assert.ok(q.isIdle());
});

test("order is preserved across many bursts", () => {
	const t = fakeTransport();
	const q = makePrintQueue({"post": t.post, "getKeymap": () => "en-us"});
	for (const ch of "hello world") {
		q.push(ch);
		if (t.inflight.length && Math.random() < 0.5) {
			t.settle();
		}
	}
	while (t.inflight.length) {
		t.settle();
	}
	assert.equal(t.sent.join(""), "hello world");
});

test("an empty push does nothing", () => {
	const t = fakeTransport();
	const q = makePrintQueue({"post": t.post, "getKeymap": () => "en-us"});
	q.push("");
	assert.deepEqual(t.sent, []);
	assert.ok(q.isIdle());
});

test("a failed request is reported and does not wedge the queue", () => {
	const t = fakeTransport();
	const errors = [];
	const q = makePrintQueue({"post": t.post, "getKeymap": () => "en-us", "onError": (i) => errors.push(i)});
	q.push("a");
	q.push("b");
	t.settle(false, {"status": 413});
	assert.deepEqual(errors, [{"status": 413}]);
	assert.deepEqual(t.sent, ["a", "b"], "the queue stopped after an error");
	t.settle();
	assert.ok(q.isIdle());
});

test("the keymap is resolved per request, not captured once", () => {
	const t = fakeTransport();
	let keymap = "en-us";
	const q = makePrintQueue({"post": t.post, "getKeymap": () => keymap});
	q.push("a");
	t.settle();
	keymap = "de";
	q.push("b");
	assert.deepEqual(t.inflight[0].keymap, "de", "a keymap change must affect the next request");
});

// ---- wiring ----

test("typing reuses the server keymap instead of mapping in the browser", () => {
	const kb = read("web/share/js/kvm/keyboard.js");
	assert.match(kb, /printText\(/, "the typing bar must go through api/hid/print");
	assert.match(kb, /hid-pak-keymap-selector/,
		"it must reuse the Text menu's keymap chooser rather than offering a second one");
	// A scancode table in the browser would be a second copy of every keymap.
	for (const f of jsFiles()) {
		assert.doesNotMatch(read(f), /SHIFTED_CHARS|CHAR_TO_SCANCODE|charToKey/,
			`${f}: character-to-scancode mapping belongs on the server`);
	}
});

test("an IME's partial composition is not typed to the host", () => {
	const kb = read("web/share/js/kvm/keyboard.js");
	assert.match(kb, /compositionstart/, "composition must suppress intermediate input events");
	assert.match(kb, /compositionend/, "the composed text must be sent when composition finishes");
});

test("the typing field cannot trigger iOS focus zoom", () => {
	const css = read("web/share/css/keypad.css");
	const block = css.slice(css.indexOf("div.keypad-type input"));
	assert.match(block, /font-size:\s*16px/,
		"a font under 16px makes iOS zoom the whole page when the field is focused");
});

test("muting the HID also mutes typing", () => {
	const kb = read("web/share/js/kvm/keyboard.js");
	const sync = kb.slice(kb.indexOf("var __syncTyped"), kb.indexOf("// The compact board shows one layer"));
	assert.match(sync, /hid-mute-switch/, "Mute KB/M must stop typed text as well as key presses");
});
