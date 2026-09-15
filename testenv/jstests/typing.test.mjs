// The compact layout's native typing bar: the phone's own keyboard drives the
// host. Characters go through the server's keymap; editing intents go out as
// key events -- through the SAME queue, so neither can overtake the other.

import test from "node:test";
import assert from "node:assert/strict";
import {read, jsFiles} from "./helpers.mjs";
import {PAD, stripPad, diffTyped, decodeEdit, makeTypingQueue} from "../../web/share/js/kvm/typing.js";

// ---- the diff ----

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

// ---- the padding ----

test("the padding is invisible and is not content", () => {
	assert.equal(PAD.length > 0, true, "an empty field reports no deletion on Android");
	assert.equal(stripPad(PAD), "");
	assert.equal(stripPad(PAD + "ls -la"), "ls -la");
	// Wherever it sits: an IME may insert in front of the caret.
	assert.equal(stripPad("ls" + PAD + " -la"), "ls -la");
	assert.equal(stripPad("ls -la"), "ls -la");
});

// ---- decoding one edit ----

test("a composed character is typed as it is composed, not at the end of the word", () => {
	// The whole of the reported bug: an IME fires one input event per letter,
	// and every one of them must reach the host. Suppressing them left the
	// letters sitting in the box with the console a word behind.
	assert.deepEqual(
		decodeEdit({"was": PAD, "now": PAD + "h", "input_type": "insertCompositionText"}),
		[{"text": "h"}]);
	assert.deepEqual(
		decodeEdit({"was": PAD + "hel", "now": PAD + "hell", "input_type": "insertCompositionText"}),
		[{"text": "l"}]);
});

test("a swipe or dictation arrives as one word and goes as one request", () => {
	assert.deepEqual(
		decodeEdit({"was": PAD, "now": PAD + "hello", "input_type": "insertText"}),
		[{"text": "hello"}]);
});

test("a delete with nothing but padding in front of the caret is still a Backspace", () => {
	// The field is reset after every edit, so this is what EVERY delete at the
	// start of a word looks like. A value diff accounts for nothing here; the
	// intent is the only thing that can answer it.
	assert.deepEqual(
		decodeEdit({"was": PAD, "now": PAD.slice(0, -1), "input_type": "deleteContentBackward"}),
		[{"key": "Backspace", "n": 1}]);
	// Even with the padding entirely gone.
	assert.deepEqual(
		decodeEdit({"was": PAD, "now": "", "input_type": "deleteContentBackward"}),
		[{"key": "Backspace", "n": 1}]);
});

test("a delete inside a composed word is one Backspace", () => {
	assert.deepEqual(
		decodeEdit({"was": PAD + "hello", "now": PAD + "hell", "input_type": "deleteContentBackward"}),
		[{"key": "Backspace", "n": 1}]);
});

test("a word-delete deletes what it can account for, and never sends a chord", () => {
	// Ctrl+Backspace means "delete word" in a GUI field and one character in a
	// shell, so it is a guess about an application we cannot see -- and it
	// would release a modifier the user had latched on the strip.
	assert.deepEqual(
		decodeEdit({"was": PAD + "hello", "now": PAD, "input_type": "deleteWordBackward"}),
		[{"key": "Backspace", "n": 5}]);
	// With nothing accounted for it is still a deletion, not nothing and not
	// the whole padding run.
	assert.deepEqual(
		decodeEdit({"was": PAD, "now": "", "input_type": "deleteWordBackward"}),
		[{"key": "Backspace", "n": 1}]);
});

test("a forward delete is a Delete, never a Backspace", () => {
	// The prefix diff reports a removed suffix as backspaces, which for a
	// forward delete is a deletion in the wrong direction.
	assert.deepEqual(
		decodeEdit({"was": PAD + "hello", "now": PAD + "hell", "input_type": "deleteContentForward"}),
		[{"key": "Delete", "n": 1}]);
	assert.deepEqual(
		decodeEdit({"was": PAD + "hello", "now": PAD + "h", "input_type": "deleteWordForward"}),
		[{"key": "Delete", "n": 1}]);
});

test("an autocorrect replacement erases back to the divergence and retypes the tail", () => {
	assert.deepEqual(
		decodeEdit({"was": PAD + "teh", "now": PAD + "the", "input_type": "insertReplacementText"}),
		[{"key": "Backspace", "n": 2}, {"text": "he"}]);
});

test("padding can never reach the host", () => {
	// Belt for an IME that inserts before the caret: the padding is structure,
	// and typing an invisible character on a console means nothing.
	assert.deepEqual(
		decodeEdit({"was": PAD, "now": PAD + "a​b", "input_type": "insertText"}),
		[{"text": "ab"}]);
});

test("an edit that changes nothing emits nothing", () => {
	assert.deepEqual(decodeEdit({"was": PAD, "now": PAD, "input_type": "insertCompositionText"}), []);
	// compositionend after the input event that already carried the commit.
	assert.deepEqual(decodeEdit({"was": PAD + "hell", "now": PAD + "hell", "input_type": null}), []);
});

test("an engine that reports no inputType still works off the diff", () => {
	assert.deepEqual(decodeEdit({"was": PAD, "now": PAD + "hi", "input_type": null}), [{"text": "hi"}]);
	assert.deepEqual(
		decodeEdit({"was": PAD + "hi", "now": PAD + "h", "input_type": null}),
		[{"key": "Backspace", "n": 1}]);
});

// ---- the queue ----

// One ordered record of everything that reached the host, whichever transport
// carried it, because the ORDER between the two is the thing under test.
function fakeHost() {
	const log = [];
	const inflight = [];
	return {
		"print": (text, keymap, done) => {
			inflight.push({text, keymap, done});
			log.push(`print:${text}`);
		},
		"sendKey": (code, state) => log.push(`key:${code}:${state ? "down" : "up"}`),
		"log": log,
		"inflight": inflight,
		"settle": (ok = true, info = null) => inflight.shift().done(ok, info),
	};
}

const queueOn = (h, extra = {}) => makeTypingQueue({
	"print": h.print, "sendKey": h.sendKey, "getKeymap": () => "en-us", ...extra,
});

test("a key never overtakes the text it follows", () => {
	// Characters go over HTTP and keys over the websocket. Dispatching the key
	// the moment it is decoded means Enter can run a command before the
	// characters of that command have arrived.
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"text": "ls -la"}, {"key": "Enter", "n": 1}]);
	assert.deepEqual(h.log, ["print:ls -la"], "Enter went out while the text was still in flight");
	h.settle();
	assert.deepEqual(h.log, ["print:ls -la", "key:Enter:down", "key:Enter:up"]);
	assert.ok(q.isIdle());
});

test("text queued behind a key waits for it", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"key": "Backspace", "n": 1}, {"text": "x"}]);
	assert.deepEqual(h.log, ["key:Backspace:down", "key:Backspace:up", "print:x"]);
});

test("a key with an idle queue goes out at once", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"key": "Backspace", "n": 1}]);
	assert.deepEqual(h.log, ["key:Backspace:down", "key:Backspace:up"]);
	assert.ok(q.isIdle(), "a key must not leave the queue busy");
});

test("a repeat count is a press and a release each time", () => {
	const h = fakeHost();
	queueOn(h).push([{"key": "Backspace", "n": 3}]);
	assert.deepEqual(h.log, [
		"key:Backspace:down", "key:Backspace:up",
		"key:Backspace:down", "key:Backspace:up",
		"key:Backspace:down", "key:Backspace:up",
	]);
});

test("only one request is ever in flight", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"text": "a"}]);
	q.push([{"text": "b"}]);
	q.push([{"text": "c"}]);
	assert.equal(h.inflight.length, 1, "a second request went out before the first came back");
	assert.deepEqual(h.log, ["print:a"]);
});

test("keystrokes typed during a request are coalesced into the next one", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"text": "a"}]);
	q.push([{"text": "b"}]);
	q.push([{"text": "c"}]);
	h.settle();
	// Two overlapping POSTs could arrive out of order and scramble the text,
	// so "bc" waits and goes as one.
	assert.deepEqual(h.log, ["print:a", "print:bc"]);
	h.settle();
	assert.ok(q.isIdle());
});

test("coalescing stops at a key, so the order survives", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"text": "a"}]);              // goes out at once
	q.push([{"text": "b"}, {"key": "Backspace", "n": 1}, {"text": "c"}]);
	h.settle();
	assert.deepEqual(h.log, ["print:a", "print:b"], "the Backspace must wait for b's request");
	h.settle();
	assert.deepEqual(h.log, ["print:a", "print:b", "key:Backspace:down", "key:Backspace:up", "print:c"]);
});

test("order is preserved across many bursts", () => {
	const h = fakeHost();
	const q = queueOn(h);
	for (const ch of "hello world") {
		q.push([{"text": ch}]);
		if (h.inflight.length && Math.random() < 0.5) {
			h.settle();
		}
	}
	while (h.inflight.length) {
		h.settle();
	}
	assert.equal(h.log.map((l) => l.slice("print:".length)).join(""), "hello world");
});

test("an empty push does nothing", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([]);
	assert.deepEqual(h.log, []);
	assert.ok(q.isIdle());
});

test("a failed request is reported and does not wedge the queue", () => {
	const h = fakeHost();
	const errors = [];
	const q = queueOn(h, {"onError": (i) => errors.push(i)});
	q.push([{"text": "a"}]);
	q.push([{"text": "b"}]);
	h.settle(false, {"status": 413});
	assert.deepEqual(errors, [{"status": 413}]);
	assert.deepEqual(h.log, ["print:a", "print:b"], "the queue stopped after an error");
	h.settle();
	assert.ok(q.isIdle());
});

test("a failed request does not strand a key behind it", () => {
	const h = fakeHost();
	const q = queueOn(h);
	q.push([{"text": "a"}, {"key": "Enter", "n": 1}]);
	h.settle(false, {"status": 500});
	assert.deepEqual(h.log, ["print:a", "key:Enter:down", "key:Enter:up"]);
});

test("the keymap is resolved per request, not captured once", () => {
	const h = fakeHost();
	let keymap = "en-us";
	const q = makeTypingQueue({"print": h.print, "sendKey": h.sendKey, "getKeymap": () => keymap});
	q.push([{"text": "a"}]);
	h.settle();
	keymap = "de";
	q.push([{"text": "b"}]);
	assert.equal(h.inflight[0].keymap, "de", "a keymap change must affect the next request");
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

test("composition gates the field reset, never the sending", () => {
	// Phase 3 suppressed input events while an IME was composing, which is what
	// left the console a whole word behind the box. Composition may now only
	// decide when the field is put back, never whether the host hears about it.
	const kb = read("web/share/js/kvm/keyboard.js");
	const listener = kb.slice(kb.indexOf(`el.addEventListener("input"`), kb.indexOf(`el.addEventListener("keydown"`));
	assert.doesNotMatch(listener, /__composing/,
		"the input handler must not consult composition state: every composed character goes to the host");
	assert.match(kb, /if \(__composing\) \{\n\t{4}\t*return; \/\/ The IME still owns the field/,
		"the reset is what composition gates");
});

test("the typing field cannot trigger iOS focus zoom", () => {
	const css = read("web/share/css/keypad.css");
	const block = css.slice(css.indexOf("div.keypad-type input"));
	assert.match(block, /font-size:\s*16px/,
		"a font under 16px makes iOS zoom the whole page when the field is focused");
});

test("muting the HID also mutes typing", () => {
	const kb = read("web/share/js/kvm/keyboard.js");
	const edit = kb.slice(kb.indexOf("var __onEdit"));
	assert.match(edit.slice(0, edit.indexOf("};")), /hid-mute-switch/,
		"Mute KB/M must stop typed text as well as key presses");
	// ...and Enter, which does not go through __onEdit.
	const keydown = kb.slice(kb.indexOf(`el.addEventListener("keydown"`), kb.indexOf("tools.el.setOnClick"));
	assert.match(keydown, /hid-mute-switch/, "a muted HID must not receive Enter either");
});
