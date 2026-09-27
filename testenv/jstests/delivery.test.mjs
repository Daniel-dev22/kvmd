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
import {serveWeb, launchBrowser, chromiumPath, centre, classOf, tap} from "./browser.mjs";

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

// The LED is the page's own answer to "can this keyboard reach the host", and
// it distinguishes all three states in its title: free/captured (online),
// "emulator offline" (the whole HID is gone) and "inactive/busy" (the gadget
// is not enumerated). Waiting on it means a test never types into a page that
// has not finished connecting -- which would measure the offline path by
// accident and pass for the wrong reason.
const KBD_TITLE = `document.getElementById("hid-keyboard-led").title`;
const LINK = `document.getElementById("link-led").className`;

async function waitOnline(pg, ms = 5000) {
	const until = Date.now() + ms;
	for (;;) {
		const [link, title] = [await pg.eval(LINK), await pg.eval(KBD_TITLE)];
		if (link === "led-green" && !title.includes("offline") && !title.includes("inactive")) {
			return;
		}
		if (Date.now() > until) {
			throw new Error(`the page never came online: link=${link} keyboard=${title}`);
		}
		await new Promise((done) => setTimeout(done, 50));
	}
}

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
		await server.waitHost(1);
		await pg.key("Backspace", "Backspace", 8);
		const host = await server.waitHost(4);
		await pg.close();
		assert.deepEqual(host, [
			"key ControlLeft down", "key ControlLeft up",
			"key Backspace down", "key Backspace up",
		], "the Backspace must not arrive as Ctrl+Backspace");
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
			assert.doesNotMatch(src, /["']api\/hid\/print["']/,
				`${f}: typing text on the host goes through printText(), which puts the board down first`);
		}
	});

	test("the releaser is registered by whoever owns the board", () => {
		const kb = read("web/share/js/kvm/keyboard.js");
		assert.match(kb, /setHeldKeyReleaser\(self\.releaseAll\)/,
			"print.js refuses to type with no releaser registered; keyboard.js is what registers it");
	});
});
