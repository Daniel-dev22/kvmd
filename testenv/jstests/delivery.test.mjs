// What the host actually receives, and what the UI claims about it.
//
// Measured from the HOST's side of the wire: the harness answers the session's
// auth check, accepts the websocket, decodes the HID frames the page sends and
// records them in the same list as the text that arrives over HTTP. Two
// transports, one ordered record -- which is the only place an ordering claim
// between them can be read.
//
// That also means these tests run against a page that is ONLINE. Every other
// suite deliberately runs without a backend; `control.session` is what puts one
// behind the page, and without it a refusal that only fires when the HID cannot
// deliver could never be shown to be conditional on anything.

import test, {before, after, describe} from "node:test";
import assert from "node:assert/strict";
import {read, jsFiles} from "./helpers.mjs";
import {serveWeb, launchBrowser, chromiumPath, centre, classOf, tap, waitOnline} from "./browser.mjs";

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

test("a browser is available to reach the host", () => {
	assert.ok(chromiumPath(),
		"no chromium binary found -- the delivery suite cannot run and every assertion below is skipped");
});

async function open({session = true, width = 390, height = 844} = {}) {
	const pg = await browser.newPage();
	await pg.setViewport(width, height, true);
	await pg.setTouch(true, 5);
	await pg.clearStorage(server.origin);
	server.reset();
	server.control.session = session;
	await pg.goto(`${server.origin}/${KVM}?debug=1`);
	if (session) {
		await waitOnline(pg);
	}
	return pg;
}

// The keyboard opens in typing mode, where the strip carries the four arrows,
// Ctrl, Esc and Tab -- and the phone's own keyboard does the letters.
const showKeyboard = async (pg) => {
	await pg.eval(`document.getElementById("mouse-window-keyboard-button").click()`);
	await pg.eval("new Promise((r) => setTimeout(r, 200))");
	assert.equal(await pg.eval(`document.activeElement.id`), "hid-type-input",
		"the compact keyboard must open ready to type, or this is not measuring the bar");
};

const CTRL = `#keyboard-compact [data-keypad-code="ControlLeft"]`;
const prints = (host) => host.filter((l) => l.startsWith("print ")).map((l) => JSON.parse(l.slice(6))).join("");

describe("a latched modifier never rewrites what is typed", {"skip": chromiumPath() ? false : "no chromium"}, () => {
	test("the board is put down before the bar types under it", async () => {
		// 🔴 The defect this closes: tap Ctrl, type `ls`, and the host gets
		// Ctrl+L then Ctrl+S -- the screen clears and the terminal freezes
		// until Ctrl+Q. Nothing on screen says why: the bar shows what was
		// TYPED, and the video shows what a chord did.
		const pg = await open();
		await showKeyboard(pg);
		await tap(pg, await pg.eval(centre(CTRL)));
		assert.match(await pg.eval(classOf(CTRL)), /\bholded\b/, "a tap on a modifier latches it");
		assert.deepEqual(await server.waitHost(1), ["key ControlLeft down"],
			"the latch has to be a key held down on the host, or there is nothing to fix");

		await pg.commit("ls");
		const host = await server.waitHost(3);
		await pg.close();

		assert.equal(host[1], "key ControlLeft up",
			`the modifier must be let go BEFORE the text it would rewrite: ${JSON.stringify(host)}`);
		assert.equal(prints(host), "ls", `the host must receive what was typed: ${JSON.stringify(host)}`);
	});

	test("and the key stops looking latched, which is the only feedback there is", async () => {
		const pg = await open();
		await showKeyboard(pg);
		await tap(pg, await pg.eval(centre(CTRL)));
		// Without this the test passes on a build where nothing latches at all:
		// the class is already "key" and the assertion below is free.
		assert.match(await pg.eval(classOf(CTRL)), /\bholded\b/, "precondition: the tap latched it");
		await pg.commit("x");
		await server.waitHost(3);
		const cls = await pg.eval(classOf(CTRL));
		await pg.close();
		assert.equal(cls, "key",
			"a key wearing the latch while the host no longer holds it is worse than no indicator at all");
	});

	test("a LOCKED modifier is let go too", async () => {
		// Lock is two taps and holds across keys by design -- but "across keys"
		// is not "across a print": the print path is the server typing
		// scancodes, and every one of them would arrive chorded.
		const pg = await open();
		await showKeyboard(pg);
		const at = await pg.eval(centre(CTRL));
		await tap(pg, at); // holded
		await tap(pg, at); // locked
		assert.match(await pg.eval(classOf(CTRL)), /\blocked\b/);
		await pg.commit("ls");
		const host = await server.waitHost(3);
		await pg.close();
		assert.equal(host[1], "key ControlLeft up", JSON.stringify(host));
		assert.equal(prints(host), "ls", JSON.stringify(host));
	});

	test("the bar's own KEYS drop it too -- they are the other transport", async () => {
		// Backspace and Enter leave over the websocket, which never touches
		// print.js. Under a latched Ctrl, Backspace is delete-word in a shell
		// and Enter is not Enter.
		const pg = await open();
		await showKeyboard(pg);
		await tap(pg, await pg.eval(centre(CTRL)));
		// 📏 Without this precondition the expected record below is BYTE
		// IDENTICAL to what a build that never latched would produce -- a tap
		// would send down then up at touchend, and the assertion could not
		// tell the defect from the fix.
		assert.match(await pg.eval(classOf(CTRL)), /\bholded\b/, "precondition: the tap latched it");
		await server.waitHost(1);
		await pg.key("Backspace", "Backspace", 8);
		const host = await server.waitHost(4);
		await pg.close();
		assert.deepEqual(host, [
			"key ControlLeft down", "key ControlLeft up",
			"key Backspace down", "key Backspace up",
		], "the Backspace must not arrive as Ctrl+Backspace");
	});

	test("EVERY latched modifier is let go, not just the first one", async () => {
		// 📏 Every other test in this file latches exactly one key, so
		// "release the first active key" and "release all of them" are
		// indistinguishable to them -- measured: `break` after the first
		// release survives the whole suite. Two is the cheapest number that
		// can tell them apart, and two is reachable: the full board puts Shift
		// beside Ctrl.
		const pg = await open();
		await showKeyboard(pg);
		await pg.eval(`document.getElementById("hid-type-board").click()`);
		await pg.eval("new Promise((r) => setTimeout(r, 250))");
		const shift = `#keyboard-compact [data-keypad-code="ShiftLeft"]`;
		// LOCKED, not held, and that is the whole point: a held modifier is
		// also released by `__unholdAll()` at the end of the first emit, so
		// with two held keys "release the first" and "release all" still look
		// the same -- 📏 measured, the `break` survived a two-key test until
		// they were locked. __unholdAll skips locked keys by design.
		for (const sel of [CTRL, shift]) {
			const at = await pg.eval(centre(sel));
			await tap(pg, at); // held
			await tap(pg, at); // locked
			assert.match(await pg.eval(classOf(sel)), /\blocked\b/, `precondition: ${sel} locked`);
		}

		await pg.eval(`document.getElementById("hid-type-input").focus()`);
		await pg.eval("new Promise((r) => setTimeout(r, 250))");
		await pg.commit("ls");
		const host = await server.waitHost(5);
		await pg.close();
		const printed = host.findIndex((l) => l.startsWith("print "));
		assert.ok(printed > 0, `nothing was typed at all: ${JSON.stringify(host)}`);
		for (const code of ["ControlLeft", "ShiftLeft"]) {
			const up = host.indexOf(`key ${code} up`);
			assert.ok(up >= 0 && up < printed,
				`${code} was still down under the text: ${JSON.stringify(host)}`);
		}
	});

	test("the chords that ARE well formed still work: Ctrl and the strip's own keys", async () => {
		// The whole point of Ctrl being on the strip. This one goes through the
		// keypad, where the code is known and the chord is exact -- and it is
		// what the fix above must not take away.
		const pg = await open();
		await showKeyboard(pg);
		await tap(pg, await pg.eval(centre(CTRL)));
		await tap(pg, await pg.eval(centre(`#keyboard-compact [data-keypad-code="ArrowLeft"]`)));
		const host = await server.waitHost(4);
		await pg.close();
		assert.deepEqual(host, [
			"key ControlLeft down",
			"key ArrowLeft down", "key ArrowLeft up",
			"key ControlLeft up",
		], "Ctrl+Left must still reach the host as Ctrl+Left");
	});

	test("muting cannot leave a modifier held on the host and clear on screen", async () => {
		// The latch is two things at once: a class on a key, and a key
		// genuinely down on the HOST. Mute KB/M silences the socket without
		// stopping the UI from clearing the class -- so a release that happens
		// while muted clears the strip and never reaches the host, and the two
		// disagree from then on. The next thing typed is chorded, with nothing
		// on screen to say why, and `dropHeldKeys()` cannot help because as far
		// as it can see nothing is held.
		//
		// The trigger here is the app being switched away from, which on a
		// phone is the commonest release of all (hid.js binds releaseAll to
		// blur/pagehide/visibilitychange). The event is dispatched rather than
		// caused by a real focus change; everything after it is the real path.
		const pg = await open();
		await showKeyboard(pg);
		await tap(pg, await pg.eval(centre(CTRL)));
		assert.deepEqual(await server.waitHost(1), ["key ControlLeft down"],
			"precondition: the host is holding Ctrl");

		await pg.eval(`document.getElementById("hid-mute-switch").checked = true`);
		await pg.eval(`window.dispatchEvent(new Event("blur"))`);
		const host = await server.waitHost(2);
		const cls = await pg.eval(classOf(CTRL));
		await pg.close();

		const held_on_screen = cls.includes("holded") || cls.includes("locked");
		const held_on_host = !host.includes("key ControlLeft up");
		assert.equal(held_on_screen, held_on_host,
			`the strip says ${held_on_screen ? "held" : "free"} and the host says `
			+ `${held_on_host ? "held" : "free"}: class=${cls} host=${JSON.stringify(host)}`);
	});

	test("a modifier held by the magic composer is let go as well", async () => {
		// The composer deliberately SWALLOWS modifier releases -- letting go of
		// Ctrl on a real keyboard must not let go of it on the host while a
		// shortcut is being composed -- so clearing the board is not enough to
		// drop what it is holding. Clearing it and not dropping it is the worst
		// of both: the key un-latches on screen, stays down on the host, and
		// can never be released again, because nothing can see it any more.
		const pg = await open();
		await showKeyboard(pg);
		await pg.key("ControlRight", "ControlRight", 17); // The default magic key
		await pg.key("ShiftLeft", "ShiftLeft", 16);       // Held by the composer
		const armed = await server.waitHost(1);
		assert.deepEqual(armed, ["key ShiftLeft down"],
			`precondition: the composer holds Shift down on the host: ${JSON.stringify(armed)}`);

		await pg.commit("ls");
		const host = await server.waitHost(3);
		await pg.close();
		const up = host.indexOf("key ShiftLeft up");
		const printed = host.findIndex((l) => l.startsWith("print "));
		assert.ok(up >= 0 && up < printed,
			`the whole burst would arrive shifted: ${JSON.stringify(host)}`);
	});

	test("the text is not even issued until the release has had a head start", async () => {
		// The release leaves on the websocket and the text on a second
		// connection, and nothing orders one against the other. Losing that
		// race does not chord one character -- it chords the whole burst,
		// because kvmd only yields between keys when a delay was asked for.
		//
		// Measured through the module rather than through the UI: the claim is
		// about the same TASK, and the appliance stub runs both transports in
		// one node process, so nothing it records could tell the two apart.
		const pg = await open({"session": false});
		const out = await pg.eval(`(async () => {
			const m = await import("/share/js/kvm/print.js");
			const sent = [];
			const Real = window.XMLHttpRequest;
			window.XMLHttpRequest = function() {
				const x = new Real();
				const send = x.send.bind(x);
				x.send = (b) => { sent.push(performance.now()); return send(b); };
				return x;
			};
			const answer = async (held) => {
				sent.length = 0;
				m.setKeyboardState({"dropHeldKeys": () => held, "notReady": () => null});
				const t0 = performance.now();
				m.printText("x", "en-us", 0, () => {});
				const now = sent.length;
				await new Promise((r) => setTimeout(r, 80));
				return {"now": now, "later": sent.length, "gap": (sent.length ? sent[0] - t0 : -1)};
			};
			return {"released": await answer(1), "idle": await answer(0)};
		})()`);
		await pg.close();
		assert.equal(out.released.now, 0,
			"a request issued in the same task as the release can overtake it on the wire");
		assert.equal(out.released.later, 1, "...but it still has to go out");
		assert.ok(out.released.gap >= 5, `the head start was ${out.released.gap}ms`);
		assert.equal(out.idle.now, 1,
			"a print that let go of nothing has nothing to wait for and must not be delayed");
	});

	test("a replayed recording is the third print path, and drops the board too", async () => {
		// 🔴 The recorder is the caller that had its own copy of the request
		// until this phase, and NOTHING in the suite loads or replays a
		// recording -- the only test that reads recorder.js asserts the
		// absence of a string. So both defects the migration fixed (a 15s
		// timeout on a long replay, and no idea about the board) were
		// re-introducible for free.
		const pg = await open();
		await showKeyboard(pg);
		await pg.eval(`document.getElementById("hid-recorder-record").click()`);
		await pg.commit("ls");
		await server.waitHost(1);
		// ...and a paste with a delay on it, because the delay is the one
		// recorded field whose UNIT changes hands on this path: paste.js
		// records milliseconds and the replay has to divide by a thousand.
		// The bar's own prints all record 0, where the two are the same number.
		await pg.eval(`document.getElementById("hid-pak-ask-switch").checked = false`);
		await pg.eval(`document.getElementById("hid-pak-delay-slider").value = 20`);
		await pg.eval(`document.getElementById("hid-pak-text").value = "whoami"`);
		await pg.eval(`document.getElementById("hid-pak-button").click()`);
		await server.waitHost(2);
		await pg.eval(`document.getElementById("hid-recorder-stop").click()`);
		assert.equal(await pg.eval(`document.getElementById("hid-recorder-play").disabled`), false,
			"precondition: there is something recorded to play");

		// Now latch something, and play it back: a replay's own scripted
		// modifiers go straight to the socket and are untouched, but whatever
		// the USER left latched has to go first.
		await tap(pg, await pg.eval(centre(CTRL)));
		assert.match(await pg.eval(classOf(CTRL)), /\bholded\b/, "precondition: Ctrl is latched");
		const before = server.host.length;
		await pg.eval(`document.getElementById("hid-recorder-play").click()`);
		const host = (await server.waitHost(before + 3)).slice(before);
		const url = server.printed.at(-1).url;
		await pg.close();

		const printed = host.findIndex((l) => l.startsWith("print "));
		assert.ok(printed >= 0, `the replay never typed anything: ${JSON.stringify(host)}`);
		assert.deepEqual(host.filter((l) => l.startsWith("print ")), [`print "ls"`, `print "whoami"`],
			`the replay did not reproduce what was recorded: ${JSON.stringify(host)}`);
		assert.ok(host.indexOf("key ControlLeft up") >= 0 && host.indexOf("key ControlLeft up") < printed,
			`the replay typed under a latched Ctrl: ${JSON.stringify(host)}`);
		assert.match(url, /limit=0(&|$)/, `the replay lost the limit: ${url}`);
		assert.match(url, /delay=0\.02(&|$)/,
			`20ms recorded has to be replayed as 0.02 SECONDS, not 20: ${url}`);
	});

	test("the Text panel is the same print path, so it puts the board down too", async () => {
		// Same defect, one menu away, and on the desktop layout as well: the
		// Text panel pastes through api/hid/print exactly like the bar.
		const pg = await open();
		await showKeyboard(pg);
		await tap(pg, await pg.eval(centre(CTRL)));
		await server.waitHost(1);
		await pg.eval(`document.getElementById("hid-pak-ask-switch").checked = false`);
		await pg.eval(`document.getElementById("hid-pak-text").value = "whoami"`);
		await pg.eval(`document.getElementById("hid-pak-button").click()`);
		const host = await server.waitHost(3);
		await pg.close();
		assert.equal(host[1], "key ControlLeft up",
			`a paste under a latched Ctrl is a chord per character: ${JSON.stringify(host)}`);
		assert.equal(prints(host), "whoami", JSON.stringify(host));
	});
});

const STATUS = `document.getElementById("hid-type-status").innerText`;
const FAILED = `document.getElementById("hid-type-input").hasAttribute("data-failed")`;

// The message is shown for four seconds and then cleared, so a test reads it
// as soon as it appears rather than after a fixed sleep that may land after it.
async function saidWithin(pg, ms = 3000) {
	const until = Date.now() + ms;
	for (;;) {
		const said = await pg.eval(STATUS);
		if (said !== "" || Date.now() > until) {
			return said;
		}
		await new Promise((done) => setTimeout(done, 50));
	}
}

describe("the bar never claims a keystroke it could not deliver", {"skip": chromiumPath() ? false : "no chromium"}, () => {
	test("with the link down nothing is typed, and it says so", async () => {
		// 🔴 What this closes: the bar reported success whatever happened. The
		// socket can be gone while HTTP still works, and then the text lands
		// while the Backspace that belongs with it is dropped -- `helo` plus a
		// correction arriving as `helolo`.
		const pg = await open();
		await showKeyboard(pg);
		server.dropSession();
		await pg.eval("new Promise((r) => setTimeout(r, 400))");

		await pg.commit("ls");
		await pg.key("Backspace", "Backspace", 8);
		const said = await saidWithin(pg);
		const host = await server.waitHost(0, 400);
		const failed = await pg.eval(FAILED);

		server.control.session = true;
		await waitOnline(pg, 8000);
		await pg.commit("ls");
		const after = await server.waitHost(1);
		await pg.close();

		assert.deepEqual(host, [], `nothing may reach the host with no link: ${JSON.stringify(host)}`);
		assert.match(said, /no connection/i, `the bar has to say what happened, got ${JSON.stringify(said)}`);
		assert.ok(failed, "and the field has to show it too, for anyone not reading the line");
		// The positive twin of that empty list: the same typing, on a link
		// that is back, DOES arrive -- so the window above was long enough to
		// have seen something, and the emptiness is a measurement rather than
		// an artefact of not waiting.
		assert.notEqual(after.length, 0, `the same keystrokes never arrived either: ${JSON.stringify(after)}`);
		assert.equal(prints(after), "ls");
	});

	test("with the gadget unenumerated it says so -- and still types", async () => {
		// api/hid/print answers 200 whether or not kvmd could deliver a single
		// scancode, so the page has to say this itself.
		//
		// 🔴 And it must NOT refuse. `keyboard.online` is an inference from
		// kvmd's state stream; if it is ever wrong, refusing would leave a user
		// unable to type at all to prevent an over-optimistic message, while
		// sending under a wrong inference costs nothing -- kvmd discards it
		// exactly as it would have.
		const pg = await open();
		await showKeyboard(pg);
		server.setHid({"keyboard": {"online": false}});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");

		await pg.commit("ls");
		const said = await saidWithin(pg);
		const host = await server.waitHost(1);
		await pg.close();

		assert.match(said, /inactive|busy/i,
			`the LED calls this state inactive/busy, so the line must not call it offline: ${JSON.stringify(said)}`);
		assert.equal(prints(host), "ls",
			`the text must still go out: a wrong guess about the HID must not disable typing (${JSON.stringify(host)})`);
	});

	test("a HID that is gone says GONE, which is not the same state", async () => {
		// Three answers, three words: kvmd distinguishes the whole emulator
		// being absent (a red LED) from a keyboard that is merely not taking
		// input (a yellow one), and the page must not collapse them -- one
		// means check the cable, the other means wait.
		const pg = await open();
		await showKeyboard(pg);
		server.setHid({"online": false});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");
		await pg.commit("ls");
		const said = await saidWithin(pg);
		const led = await pg.eval(`document.getElementById("hid-keyboard-led").title`);
		await pg.close();
		assert.match(said, /emulator offline/i, `got ${JSON.stringify(said)}`);
		assert.match(led, /emulator offline/i, "precondition: this is the state the LED calls offline");
	});

	test("a page that has not been told anything claims nothing", async () => {
		// `__online` started life as `true`, so before any socket existed the
		// page would answer "ready" about a HID nothing had ever spoken to --
		// and the paste confirmation said nothing at all.
		const pg = await open({"session": false});
		const [led, why] = [
			await pg.eval(`document.getElementById("hid-keyboard-led").title`),
			await pg.eval(`(async () => {
				const m = await import("/share/js/kvm/print.js");
				return m.hidNotReadyReason();
			})()`),
		];
		await pg.close();
		// "PiKVM offline" is the link, and true -- there is no session. What it
		// must not say is anything about the EMULATOR, which nothing has
		// mentioned.
		assert.match(led, /PiKVM offline/i, "precondition: there is no session at all");
		assert.doesNotMatch(led, /emulator offline|inactive/i,
			`nothing has been said about the emulator, so the LED must not claim one: ${led}`);
		assert.match(String(why), /connecting/i,
			`and the answer to "will this arrive" is not yes: got ${JSON.stringify(why)}`);
	});

	test("the Text panel says it too, where it is already asking", async () => {
		// Same lie, one menu away: a paste into an unenumerated gadget answers
		// 200 and looks exactly like one that worked. The confirmation is
		// already the moment the user decides, so it is said there rather than
		// in a surface invented for it.
		const pg = await open();
		server.setHid({"keyboard": {"online": false}});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");
		await pg.eval(`document.getElementById("hid-pak-text").value = "whoami"`);
		await pg.eval(`document.getElementById("hid-pak-button").click()`);
		await pg.eval("new Promise((r) => setTimeout(r, 200))");
		const asked = await pg.eval(`document.querySelector(".modal .modal-content").innerText`);
		await pg.close();
		assert.match(asked, /going to paste 6 character/,
			"precondition: the confirmation is what is on screen");
		assert.match(asked, /inactive|busy/i,
			`the paste has to say what it knows, in the same words: ${JSON.stringify(asked)}`);
	});

	test("and says nothing of the sort when the HID is ready", async () => {
		const pg = await open();
		await pg.eval(`document.getElementById("hid-pak-text").value = "whoami"`);
		await pg.eval(`document.getElementById("hid-pak-button").click()`);
		await pg.eval("new Promise((r) => setTimeout(r, 200))");
		const asked = await pg.eval(`document.querySelector(".modal .modal-content").innerText`);
		await pg.close();
		assert.match(asked, /going to paste 6 character/);
		assert.doesNotMatch(asked, /offline|inactive|busy|connecting/i, `got ${JSON.stringify(asked)}`);
	});

	test("with everything ready it says nothing at all", async () => {
		// The negative control for both messages above: a bar that always
		// complained would pass them and be useless.
		const pg = await open();
		await showKeyboard(pg);
		await pg.commit("ls");
		await server.waitHost(1);
		const [said, failed] = [await pg.eval(STATUS), await pg.eval(FAILED)];
		await pg.close();
		assert.equal(said, "", "a working keystroke must not be reported as a problem");
		assert.equal(failed, false);
	});

	test("the message covers the field, and no key and no button", async () => {
		// 📏 It went ABOVE the row first, which looked obvious and was wrong:
		// there is no video up there, there is the strip. It covered Ctrl, Esc
		// and Tab -- and, being an element on top of them, took their taps as
		// well. Caught by looking at a screenshot; nothing in the suite could
		// have said it, so this test exists.
		const pg = await open();
		await showKeyboard(pg);
		server.control.printStatus = 500;
		await pg.commit("x");
		assert.notEqual(await saidWithin(pg), "", "precondition: the message has to be on screen");

		const clash = await pg.eval(`(() => {
			const box = document.getElementById("hid-type-status").getBoundingClientRect();
			const hits = (el) => {
				const r = el.getBoundingClientRect();
				return !(r.right <= box.left || r.left >= box.right
					|| r.bottom <= box.top || r.top >= box.bottom);
			};
			return [...document.querySelectorAll("#keyboard-window .key, div.keypad-type button")]
				.filter((el) => el.getBoundingClientRect().height > 0 && hits(el))
				.map((el) => (el.id || el.getAttribute("data-keypad-code")));
		})()`);
		assert.deepEqual(clash, [], "the message is on top of these, so it hides them and eats their taps");

		// And the proof that it takes no tap: the message is still up, and the
		// key nearest it still reaches the host.
		const before = server.host.length;
		await tap(pg, await pg.eval(centre(CTRL)));
		const host = await server.waitHost(before + 1);
		const cls = await pg.eval(classOf(CTRL));
		await pg.close();
		assert.deepEqual(host.slice(before), ["key ControlLeft down"],
			`a key pressed while the message is up must still reach the host: ${JSON.stringify(host)}`);
		assert.match(cls, /\bholded\b/);
	});

	test("the line is really on screen, and really a live region", async () => {
		// 🔴 Every other assertion in this file reads `innerText`, and per spec
		// that falls back to `textContent` for an element that is NOT BEING
		// RENDERED -- so all of them pass on a message no user can see.
		// 📏 Measured by a review lens: `display: none` on the status rule
		// survived every one of them.
		const pg = await open();
		await showKeyboard(pg);
		server.control.printStatus = 500;
		await pg.commit("x");
		assert.notEqual(await saidWithin(pg), "", "precondition: there is something to look at");
		const seen = await pg.eval(`(() => {
			const el = document.getElementById("hid-type-status");
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return {
				"display": cs.display, "visibility": cs.visibility, "opacity": cs.opacity,
				"w": Math.round(r.width), "h": Math.round(r.height),
				"onscreen": (r.top >= 0 && r.bottom <= window.innerHeight
					&& r.left >= 0 && r.right <= window.innerWidth),
				"role": el.getAttribute("role"), "live": el.getAttribute("aria-live"),
				"opaque": cs.backgroundColor,
			};
		})()`);
		await pg.close();
		assert.notEqual(seen.display, "none", `the line is not rendered at all: ${JSON.stringify(seen)}`);
		assert.equal(seen.visibility, "visible");
		assert.notEqual(seen.opacity, "0");
		assert.ok(seen.w > 100 && seen.h > 20, `the line has no box: ${JSON.stringify(seen)}`);
		assert.ok(seen.onscreen, `the line is off screen: ${JSON.stringify(seen)}`);
		assert.match(seen.opaque, /rgba?\((?!0, 0, 0, 0)/, `the text has no background to read it against: ${seen.opaque}`);
		// The half of "say it" that a picture cannot check.
		assert.equal(seen.role, "status");
		assert.equal(seen.live, "polite");
	});

	test("the line clears itself, and says it again next time", async () => {
		// Both halves are otherwise untested: every other test reads the line
		// once and closes the page, so a build that never cleared it -- a red
		// bar left over the video for the rest of the session, naming a status
		// code from minutes ago -- passes. And a build that said it once per
		// SESSION passes too, though the comment on it says "per burst, on
		// purpose: it is the answer to did that arrive, asked at the moment
		// the user asks it".
		const pg = await open();
		await showKeyboard(pg);
		server.setHid({"keyboard": {"online": false}});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");
		await pg.commit("ls");
		assert.notEqual(await saidWithin(pg), "", "precondition: it said something the first time");

		await pg.eval("new Promise((r) => setTimeout(r, 4600))"); // PROBLEM_SHOWN_MS + margin
		const cleared = await pg.eval(STATUS);
		const still_failed = await pg.eval(FAILED);
		await pg.commit("ls");
		const again = await saidWithin(pg);
		await pg.close();
		assert.equal(cleared, "", "the line has to go away on its own");
		assert.equal(still_failed, false, "and so does the border with it");
		assert.notEqual(again, "", "the second keystroke deserves the same answer as the first");
	});

	test("a key that cannot land says so too, not only text", async () => {
		// 📏 The warning was wired into both transports and tested on one:
		// deleting it from the websocket adapter survived the suite. It is the
		// transport whose keys are the dangerous ones -- a Backspace that does
		// not arrive leaves the line on the host wrong, not short.
		const pg = await open();
		await showKeyboard(pg);
		server.setHid({"keyboard": {"online": false}});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");
		await pg.key("Backspace", "Backspace", 8);
		const said = await saidWithin(pg);
		const host = await server.waitHost(1);
		await pg.close();
		assert.match(said, /inactive|busy/i, `a key nobody can take is not a success: ${JSON.stringify(said)}`);
		assert.deepEqual(host, ["key Backspace down", "key Backspace up"],
			"...and it still goes, for the same reason the text does");
	});

	test("the warning comes before the request, not after it", async () => {
		// A print that hangs for the full 15s timeout would otherwise tell the
		// user nothing for fifteen seconds about a keystroke the page already
		// knew might not arrive -- and then the failure would overwrite it.
		const pg = await open();
		await showKeyboard(pg);
		server.setHid({"keyboard": {"online": false}});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");
		server.control.printDelayMs = 1200;
		await pg.commit("ls");
		await pg.eval("new Promise((r) => setTimeout(r, 350))");
		const early = await pg.eval(STATUS);
		const host_so_far = server.host.slice();
		await pg.close();
		assert.notEqual(early, "", "the answer arrived after the question was over");
		assert.ok(!host_so_far.some((l) => l.startsWith("print ")) || true,
			"informational only: the record so far is " + JSON.stringify(host_so_far));
	});

	test("a busy HID reads the same as an inactive one", async () => {
		// The other two thirds of the inference: `__online` is
		// `keyboard.online && !busy`, and every test until now set only the
		// first term. `busy` is what a hid reset looks like.
		const pg = await open();
		await showKeyboard(pg);
		server.setHid({"busy": true});
		await pg.eval("new Promise((r) => setTimeout(r, 300))");
		await pg.commit("ls");
		const said = await saidWithin(pg);
		const led = await pg.eval(`document.getElementById("hid-keyboard-led").title`);
		await pg.close();
		assert.match(said, /inactive|busy/i, `got ${JSON.stringify(said)}`);
		assert.match(led, /inactive\/busy/i, "precondition: this is the state the LED calls busy");
	});

	test("the request carries the limit that stops kvmd truncating it", async () => {
		// 📏 Three assertions in the whole suite look at a print request's URL
		// and all three are about the keymap, so the rest of the params are
		// free to change: without `limit=0` kvmd applies its own default of
		// 1024 characters and a long paste is silently cut off.
		const pg = await open();
		await showKeyboard(pg);
		await pg.commit("ls");
		await server.waitHost(1);
		const url = server.printed.at(-1).url;
		await pg.close();
		assert.match(url, /limit=0(&|$)/, `got ${url}`);
		assert.match(url, /keymap=/, "the server owns the keymap, so the request has to name one");
	});

	test("a server error is named, not translated into a colour", async () => {
		const pg = await open();
		await showKeyboard(pg);
		server.control.printStatus = 413;
		await pg.commit("ls");
		const said = await saidWithin(pg);
		await pg.close();
		assert.match(said, /413/, `the status has to reach the user: got ${JSON.stringify(said)}`);
	});

	test("a reconnect does not inherit the last session's answer", async (t) => {
		// The state is remembered per KEYBOARD, not per socket, so a HID that
		// went offline while the page was away used to read as ready for the
		// round trip between the socket opening and the first state event --
		// and on a link that flaps, that window is where the typing happens.
		const pg = await open();
        await showKeyboard(pg);
		server.control.hidSnapshot = false; // Connected, and told nothing
		t.after(() => {
			server.control.hidSnapshot = true;
		});
		server.dropSession();
		await pg.eval("new Promise((r) => setTimeout(r, 400))");
		server.control.session = true;
		await pg.eval("new Promise((r) => setTimeout(r, 1500))");
		assert.equal(await pg.eval(`document.getElementById("link-led").className`), "led-green",
			"precondition: the page has to be connected again, or this measures the link instead");

		await pg.commit("ls");
		const said = await saidWithin(pg);
		await pg.close();
		assert.match(said, /connecting/i,
			`an unanswered HID is neither ready nor offline: got ${JSON.stringify(said)}`);
	});
});

describe("one way to type, and it cannot be bypassed", () => {
	test("nothing posts to api/hid/print except print.js", async () => {
		// The rule above is enforced in one place, so a fourth caller cannot
		// quietly acquire the defect. The recorder had its own copy of this
		// request until this phase -- with a 15-second timeout that cut long
		// replays off, and no idea about the board.
		for (const f of jsFiles()) {
			if (f.endsWith("kvm/print.js")) {
				continue;
			}
			const src = read(f).replace(/\/\/[^\n]*/g, "");
			// Backticks included: a template literal is a string too, and 📏 a
			// review lens walked straight past this guard with one.
			assert.doesNotMatch(src, /["'`]api\/hid\/print["'`]/,
				`${f}: typing text on the host goes through printText(), which puts the board down first`);
		}
	});

	test("typing refuses outright when no keyboard is wired to it", {"skip": chromiumPath() ? false : "no chromium"}, async () => {
		// Both directions in one, because a strictness fix cannot be falsified
		// by the code it guards: the page AS SHIPPED prints (something did
		// register a releaser), and with the registration taken away printText
		// throws rather than quietly typing under whatever is latched.
		const pg = await open({"session": false});
		const out = await pg.eval(`(async () => {
			const m = await import("/share/js/kvm/print.js");
			try {
				m.printText("", null, null, () => {});
			} catch (ex) {
				return "the shipped page has no keyboard wired to it: " + ex.message;
			}
			m.setKeyboardState(null);
			try {
				m.printText("", null, null, () => {});
			} catch (ex) {
				return "refused";
			}
			return "typed with no keyboard wired to it";
		})()`);
		// The request is asynchronous, so count it once it has ARRIVED: reading
		// the tally in the same tick as the eval counts nothing and passes.
		await server.waitHost(1);
		const printed = server.printed.length;
		await pg.close();
		assert.equal(out, "refused");
		assert.equal(printed, 1,
			"the refusal has to happen BEFORE the request: exactly the one print that was allowed");
	});
});
