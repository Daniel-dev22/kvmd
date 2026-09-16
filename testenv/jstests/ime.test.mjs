// What a phone's own keyboard actually delivers, and what the host gets for it.
//
// Every event below is the ENGINE's: `Input.imeSetComposition` drives Chrome's
// real IME path, so compositionstart/compositionupdate and the
// insertCompositionText events are the browser's own, and `Input.dispatchKeyEvent`
// runs the editor's default action so Backspace genuinely removes a character
// from the field. A synthetic `new Event("input")` -- which is how this bar was
// tested until Phase 7 -- is the one delivery shape Android never produces, and
// it is why the suite was green while the bar was a word behind the console.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {serveWeb, launchBrowser, chromiumPath} from "./browser.mjs";

const KVM = "kvm/index.html";

let server = null;
let browser = null;

before(async () => {
	server = await serveWeb();
	browser = await launchBrowser();
});
after(async () => {
	await browser?.close();
	await server?.close();
});

test("a browser is available to drive an IME", () => {
	assert.ok(chromiumPath(),
		"no chromium binary found -- the IME suite cannot run and every assertion below is skipped");
});

// ===========================================================================
// What the host receives, in ONE ordered record.
//
// Characters leave over HTTP and keys over the websocket, and the ORDER
// between the two transports is most of what this phase is about -- so both
// are recorded into the same list. Keys are read from tools.debug on the line
// beside the websocket write (?debug=1); prints are read from XHR, filtered to
// api/hid/print so the page's own polling cannot pad the record.
// ===========================================================================

const HOST_START = `(() => {
	window.__host = [];
	window.__timeouts = [];
	const real = console.log;
	console.log = function(...args) {
		const m = args.join(" ").match(/Keyboard: key (pressed|released): (\\S+)/);
		if (m !== null) {
			window.__host.push("key " + m[2] + (m[1] === "pressed" ? " down" : " up"));
		}
		return real.apply(console, args);
	};
	const Real = window.XMLHttpRequest;
	window.XMLHttpRequest = function() {
		const x = new Real();
		const open = x.open.bind(x);
		const send = x.send.bind(x);
		let url = null;
		let body = null;
		// Registered HERE, at construction, so it runs before the handler the
		// page attaches -- listeners fire in registration order, and the page
		// dispatches the next queued key from inside its own. Attached any
		// later, this records the print AFTER the key that waited for it and
		// reports a correct build as broken.
		//
		// And on COMPLETION, never on dispatch: recorded at dispatch, "in
		// flight" is unobservable, so a build that fires Enter the moment it is
		// pressed -- this phase's own headline defect -- logs in exactly the
		// same order as one that queues it.
		// 📏 Measured: with this at send(), reintroducing the immediate Enter
		// survived all 278 tests; with it here, that build fails with
		// ["key Enter down","key Enter up","print \"ls -la\""].
		x.addEventListener("readystatechange", function() {
			if (x.readyState === 4 && url !== null && url.includes("api/hid/print")) {
				window.__host.push(
					(x.status === 200 ? "print " : "print-failed:" + x.status + " ")
					+ JSON.stringify(body));
			}
		});
		x.open = (m, u, a) => { url = u; return open(m, u, a); };
		x.send = (b) => {
			body = b;
			if (url !== null && url.includes("api/hid/print")) {
				window.__timeouts.push(x.timeout);
			}
			return send(b);
		};
		return x;
	};
	if (!window.location.search.includes("debug=1")) {
		throw new Error("the page was not opened with ?debug=1: no key is logged and half of these assertions are free");
	}
	return true;
})()`;

const FIELD = `document.getElementById("hid-type-input")`;

async function openTyping() {
	const pg = await browser.newPage();
	await pg.setViewport(390, 844, true);
	await pg.setTouch(true, 5);
	await pg.clearStorage(server.origin);
	server.reset();
	await pg.goto(`${server.origin}/${KVM}?debug=1`);
	await pg.eval(`document.getElementById("mouse-window-keyboard-button").click()`);
	await pg.eval("new Promise((r) => setTimeout(r, 200))");
	// The bar opens focused and padded, or nothing below is measuring the bar.
	assert.equal(await pg.eval(`document.activeElement.id`), "hid-type-input",
		"the compact keyboard must open ready to type");
	assert.ok(await pg.eval(`${FIELD}.value.length > 0`),
		"an empty field reports no deletion on Android: the padding is the whole mechanism");
	assert.equal(await pg.eval(`${FIELD}.value.replace(/\\u200b/gu, "")`), "",
		"the padding must be zero-width, never content");
	assert.ok(await pg.eval(HOST_START));
	return pg;
}

// Waits for what was asked for rather than sleeping a guessed number of
// milliseconds. An expectation of NOTHING MORE has to wait out the window.
async function hostSettled(pg, want, ms = 2000) {
	const until = Date.now() + ms;
	do {
		const seen = await pg.eval("window.__host");
		if (want > 0 && seen.length >= want) {
			break;
		}
		await pg.eval("new Promise((r) => setTimeout(r, 50))");
	} while (Date.now() < until);
	await pg.eval("new Promise((r) => setTimeout(r, 200))");
	return pg.eval("window.__host");
}

// Waits for a condition to become true rather than sampling it once after a
// guessed delay. The failure cue clears itself after 2s, so a single late
// sample races its own expiry -- which is a flake that only shows under load.
async function waitFor(pg, expression, ms = 2000) {
	const until = Date.now() + ms;
	do {
		if (await pg.eval(expression)) {
			return true;
		}
		await pg.eval("new Promise((r) => setTimeout(r, 40))");
	} while (Date.now() < until);
	return false;
}

// Characters are coalesced into one request per burst, deliberately, so the
// text that reached the host is the concatenation and not the request count.
const typed = (host) => host
	.filter((e) => e.startsWith("print "))
	.map((e) => JSON.parse(e.slice("print ".length)))
	.join("");

describe("the typing bar", {"skip": chromiumPath() ? false : "no chromium available"}, () => {

	test("a composed word reaches the host as it is typed, not when it commits", async () => {
		// 📏 The reported bug, measured before the fix: the five letters below
		// produced NOTHING on the host until a space committed the word, and
		// the box sat there holding text the console did not have.
		const pg = await openTyping();
		for (const part of ["h", "he", "hel", "hell", "hello"]) {
			await pg.compose(part);
		}
		const host = await hostSettled(pg, 1);
		await pg.close();
		assert.equal(typed(host), "hello", `the host received: ${JSON.stringify(host)}`);
	});

	test("a delete inside a composing word reaches the host", async () => {
		// A phone deletes inside a word by re-composing it shorter, which is
		// what Gboard does and what the suppressed path threw away entirely.
		const pg = await openTyping();
		for (const part of ["h", "he", "hel"]) {
			await pg.compose(part);
		}
		await hostSettled(pg, 1);
		await pg.compose("he");
		const host = await hostSettled(pg, 4);
		await pg.close();
		assert.equal(typed(host), "hel", "the deletion must not retype the line");
		// Every key, not just the last two -- a slice hides a duplicate or an
		// out-of-order event that happened earlier.
		assert.deepEqual(host.filter((e) => e.startsWith("key ")),
			["key Backspace down", "key Backspace up"],
			`the host received: ${JSON.stringify(host)}`);
	});

	test("a Backspace with nothing but padding in the field still reaches the host", async () => {
		// The field is put back to its padding after every edit, so this is
		// every delete at the start of a word -- and with an empty field
		// Android reports no deletion at all, which is the bug the padding
		// exists to stop.
		const pg = await openTyping();
		await pg.compose("hi");
		await pg.commit("hi ");
		await hostSettled(pg, 1);
		assert.equal(await pg.eval(`${FIELD}.value.replace(/\\u200b/gu, "")`), "",
			"the committed word must not stay in the field");
		await pg.key("Backspace", "Backspace", 8);
		const host = await hostSettled(pg, 3);
		await pg.close();
		assert.deepEqual(host.filter((e) => e.startsWith("key ")),
			["key Backspace down", "key Backspace up"],
			`the host received: ${JSON.stringify(host)}`);
	});

	test("Enter reaches the host once, and after the text it runs", async () => {
		// Two transports: Enter over the websocket, the command over HTTP. Sent
		// the moment it was pressed it ran the line before the line arrived --
		// and it was ALSO going out a second time as a scancode, because this
		// handler is bound on the whole keyboard window.
		const pg = await openTyping();
		await pg.commit("ls -la");
		await pg.key("Enter", "Enter", 13);
		const host = await hostSettled(pg, 3);
		await pg.close();
		assert.deepEqual(host, ["print \"ls -la\"", "key Enter down", "key Enter up"],
			`the host received: ${JSON.stringify(host)}`);
	});

	test("the padding never reaches the host", async () => {
		const pg = await openTyping();
		await pg.compose("ab");
		await pg.commit("ab ");
		await pg.key("Backspace", "Backspace", 8);
		await pg.compose("c");
		const host = await hostSettled(pg, 5);
		await pg.close();
		for (const e of host.filter((x) => x.startsWith("print "))) {
			assert.doesNotMatch(e, /​/u, `a request carried the padding: ${e}`);
		}
		assert.equal(typed(host), "ab c", `the host received: ${JSON.stringify(host)}`);
	});

	test("a hardware key types through the bar instead of going out twice", async () => {
		// Every key pressed in the bar was also translated to a scancode by the
		// window-level handler, which preventDefault()ed it before it could
		// reach the field -- so a hardware keyboard could not type into the bar
		// at all, and Enter reached the host twice.
		const pg = await openTyping();
		await pg.key("a", "KeyA", 65, {"text": "a"});
		const host = await hostSettled(pg, 1);
		await pg.close();
		assert.equal(typed(host), "a", `the host received: ${JSON.stringify(host)}`);
		assert.equal(host.filter((e) => e.startsWith("key ")).length, 0,
			`a character must not also go out as a scancode: ${JSON.stringify(host)}`);
	});

	test("what the bar cannot express still goes out as a scancode", async () => {
		// A chord in a console is not optional, and Esc, Tab and the arrows are
		// not part of the line being typed. They are not the bar's to swallow.
		//
		// The chord is Ctrl+Q and not Ctrl+C on purpose: Chrome claims Ctrl+C
		// as Copy and does not always dispatch a keydown for it at all, so a
		// test written with it measures the browser's clipboard, not this page.
		const pg = await openTyping();
		await pg.key("q", "KeyQ", 81, {"modifiers": 2});
		await pg.key("Escape", "Escape", 27);
		await pg.key("Tab", "Tab", 9);
		await pg.key("ArrowUp", "ArrowUp", 38);
		const host = await hostSettled(pg, 8);
		await pg.close();
		assert.deepEqual(host.filter((e) => e.endsWith(" down")), [
			"key KeyQ down", "key Escape down", "key Tab down", "key ArrowUp down",
		], `the host received: ${JSON.stringify(host)}`);
		assert.equal(typed(host), "", "none of these are characters to print");
	});

	test("muting the HID stops typed text and Enter alike", async () => {
		const pg = await openTyping();
		await pg.eval(`document.getElementById("hid-mute-switch").checked = true`);
		await pg.compose("hello");
		await pg.commit("hello");
		await pg.key("Enter", "Enter", 13);
		const host = await hostSettled(pg, 0, 900);
		await pg.close();
		assert.deepEqual(host, [], `a muted HID received: ${JSON.stringify(host)}`);
	});

	// A host that answers instantly makes "in flight" sub-millisecond, and every
	// ordering claim this phase makes lives inside that window. These hold it
	// open on purpose. Each carries the mutation that proved it was missing.

	test("Backspace goes through the queue, not straight out as a scancode", async () => {
		// 📏 Swapping Backspace for Delete in the bar's claimed-key list -- which
		// hands Backspace to the window handler, firing it over the websocket
		// the instant it is pressed -- survived all 278 tests. Asserting that a
		// Backspace ARRIVED cannot tell the two paths apart.
		const pg = await openTyping();
		server.control.printDelayMs = 300;
		await pg.commit("abc");
		await pg.key("Backspace", "Backspace", 8);
		const host = await hostSettled(pg, 3);
		await pg.close();
		assert.deepEqual(host, ["print \"abc\"", "key Backspace down", "key Backspace up"],
			`the Backspace overtook the text it was meant to erase: ${JSON.stringify(host)}`);
	});

	test("a failed print drops the Enter that was queued behind it", async () => {
		// 📏 While the stub could only answer 200, the queue's failure path was
		// unreachable from the browser suite -- so a build reporting every
		// failure as success survived, with the orphaned Enter this phase names
		// as its worst case live again.
		const pg = await openTyping();
		// Slow AND broken: the Enter has to be queued while the print is still
		// in flight. 📏 With an instant failure this test was a coin flip --
		// the queue is aborted and empty before the Enter is pressed, so it
		// goes out alone, which is a different question from the one here.
		server.control.printDelayMs = 400;
		server.control.printStatus = 500;
		await pg.commit("rm -rf /tmp/x");
		await pg.eval("new Promise((r) => setTimeout(r, 80))");
		await pg.key("Enter", "Enter", 13);
		const failed = await waitFor(pg, `${FIELD}.hasAttribute("data-failed")`);
		const host = await hostSettled(pg, 0, 800);
		await pg.close();
		assert.equal(host.filter((e) => e.startsWith("key Enter")).length, 0,
			`an orphaned Enter reached the host: ${JSON.stringify(host)}`);
		assert.ok(failed, "a failure the user cannot see is one they will retype into");
	});

	test("the keymap on the request is the one the selector holds", async () => {
		// 📏 Hardcoding "en-us" survived: the only assertions were a match on
		// the source text and one that the parameter EXISTS. Every non-US user
		// types the wrong characters.
		const pg = await openTyping();
		await pg.eval(`(() => { const el = document.getElementById("hid-pak-keymap-selector");
			el.innerHTML = '<option value="de">de</option>'; el.value = "de"; return el.value; })()`);
		await pg.commit("z");
		await hostSettled(pg, 1);
		await pg.close();
		assert.match(server.printed.at(-1).url, /keymap=de(&|$)/,
			`the request carried: ${server.printed.at(-1).url}`);
		assert.equal(server.printed.at(-1).body, "z");
	});

	test("an interactive print does not inherit the paste timeout", async () => {
		// 📏 printText's default is 7*24*3600 -- seconds written into a
		// milliseconds parameter, so "a week" is ten minutes, and every key
		// behind it in the queue waits that long. Nothing asserted it.
		const pg = await openTyping();
		await pg.commit("x");
		await hostSettled(pg, 1);
		const timeouts = await pg.eval("window.__timeouts");
		await pg.close();
		assert.deepEqual(timeouts, [15000], `the print's timeout was ${JSON.stringify(timeouts)}`);
	});

	test("a deletion is seen even when the engine reports no inputType", async () => {
		// Blink always supplies one, so the padding mechanism -- the whole
		// reason this field is never empty -- cannot be reached through the IME
		// path at all, and 📏 a build that stopped tracking it survived. This
		// drives the glue the way an engine that omits inputType would: the
		// padding is one character shorter and nothing else changed.
		const pg = await openTyping();
		await pg.eval(`(() => { const el = ${FIELD};
			el.value = el.value.slice(0, -1);
			el.dispatchEvent(new Event("input", {bubbles: true}));
			return true; })()`);
		const host = await hostSettled(pg, 2);
		await pg.close();
		assert.deepEqual(host, ["key Backspace down", "key Backspace up"],
			`the host received: ${JSON.stringify(host)}`);
	});

	test("an AltGr character belongs to the bar, not to the scancode path", async () => {
		// 📏 Removing the AltGr exemption survived -- the claim had no test at
		// all. AltGr is Ctrl+Alt on Windows and Linux, so testing those flags
		// alone refuses every AltGr character and sends it as a raw scancode
		// for the HOST's layout to reinterpret: the second keymap the print
		// path exists to avoid. CDP cannot set AltGraph, so the event is
		// constructed -- which runs no default action, and is why this asserts
		// what did NOT go out rather than what was typed.
		const pg = await openTyping();
		await pg.eval(`${FIELD}.dispatchEvent(new KeyboardEvent("keydown", {
			bubbles: true, key: "@", code: "KeyQ",
			ctrlKey: true, altKey: true, modifierAltGraph: true}))`);
		const host = await hostSettled(pg, 0, 700);
		await pg.close();
		assert.deepEqual(host, [],
			`an AltGr character went out as a scancode: ${JSON.stringify(host)}`);
	});

	test("the field is not reset under an edit that is still being delivered", async () => {
		// Mutating the value inside the handler is how an IME ends up
		// duplicating what it just inserted, so the reset waits for the next
		// task. 📏 Making it synchronous survived: the only assertion on this
		// was a match against its own comment.
		const pg = await openTyping();
		const seen = await pg.eval(`(() => { const el = ${FIELD};
			el.value = el.value + "q";
			el.dispatchEvent(new Event("input", {bubbles: true}));
			return el.value.replace(/\u200b/gu, "");
		})()`);
		await pg.eval("new Promise((r) => setTimeout(r, 120))");
		const after = await pg.eval(`${FIELD}.value.replace(/\u200b/gu, "")`);
		await pg.close();
		assert.equal(seen, "q", "the field was reset inside the handler still delivering the edit");
		assert.equal(after, "", "the field never went back to its padding");
	});

	test("muting after text is queued stops it reaching the host", async () => {
		// __onEdit gates on mute before queueing, so the adapter's own check
		// only matters for work queued BEFORE the switch flipped -- which no
		// test exercised, and 📏 a build without it survived.
		const pg = await openTyping();
		server.control.printDelayMs = 250;
		await pg.commit("aaa");
		await pg.commit("bbb");
		await pg.eval(`document.getElementById("hid-mute-switch").checked = true`);
		// Waits for the SECOND print it must never see. Stopping at the first
		// returns before the second could have completed, so the assertion
		// passed whether or not the mute was honoured -- 📏 the mutation that
		// drops the check survived this test until it waited out the window.
		const host = await hostSettled(pg, 2, 2500);
		await pg.close();
		assert.equal(typed(host), "aaa", `a muted HID received: ${JSON.stringify(host)}`);
	});

	test("a composition that never ends does not latch the field open", async () => {
		// 📏 Disabling __clearField's reset of __composing survived: both
		// assertions on it matched the SOURCE TEXT, which the mutation left
		// alone. An Android tab frozen mid-word never fires compositionend, so
		// __composing latched, every later reset was skipped, and the field
		// went back to being the accumulating transcript this phase deleted.
		// Chrome always fires compositionend, so the only way to reach it is to
		// start a composition that never finishes.
		const pg = await openTyping();
		await pg.eval(`${FIELD}.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true}))`);
		await pg.eval(`${FIELD}.blur()`);
		await pg.eval("new Promise((r) => setTimeout(r, 250))");
		await pg.eval(`${FIELD}.focus()`);
		await pg.eval("new Promise((r) => setTimeout(r, 100))");
		await pg.eval(`(() => { const el = ${FIELD};
			el.value = el.value + "zz";
			el.dispatchEvent(new Event("input", {bubbles: true}));
			return true; })()`);
		await pg.eval("new Promise((r) => setTimeout(r, 200))");
		const left = await pg.eval(`${FIELD}.value.replace(/\u200b/gu, "")`);
		await pg.close();
		assert.equal(left, "", `the field latched open and kept a transcript: ${JSON.stringify(left)}`);
	});

	test("the field never accumulates a transcript", async () => {
		// There is no feedback channel from the host, so a field that kept what
		// was typed would disagree with the console the moment anything else
		// touched it -- a strip key, Tab completion, a paste, the host's own
		// output. Nothing durable is allowed to build up in it.
		const pg = await openTyping();
		for (const word of ["one", "two", "three"]) {
			await pg.compose(word);
			await pg.commit(`${word} `);
			await hostSettled(pg, 1);
		}
		const left = await pg.eval(`${FIELD}.value.replace(/\\u200b/gu, "")`);
		await pg.close();
		assert.equal(left, "", `the field kept a transcript: ${JSON.stringify(left)}`);
	});
});
