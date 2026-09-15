// The terminal is somebody else's application in an iframe, so the only handle
// we have on how it renders is its URL. ttyd 1.7.7 merges the URL query over
// its own client options AND the server's -t flags, and a key it does not know
// falls through to xterm's own options -- which is how the font size gets set
// from out here, with no ttyd flag and no reload of a live shell.
// (html/src/components/terminal/xterm/index.ts: parseOptsFromUrlQuery, spread
// last into applyPreferences; the default branch assigns terminal.options[key].)

import test from "node:test";
import assert from "node:assert/strict";
import {read} from "./helpers.mjs";
import {webtermUrl, WEBTERM_COMPACT_FONT_PX} from "../../web/share/js/kvm/webterm.js";

const BASE = "https://pikvm.example.net/";

test("a phone gets a font size it can read", () => {
	const url = new URL(webtermUrl(BASE, "webterm", true));
	assert.equal(url.searchParams.get("fontSize"), String(WEBTERM_COMPACT_FONT_PX));
	assert.ok(WEBTERM_COMPACT_FONT_PX > 15,
		"xterm's own default is 15px -- anything at or below it changes nothing");
});

test("the desktop keeps the terminal's own default", () => {
	const url = new URL(webtermUrl(BASE, "webterm", false));
	assert.equal(url.searchParams.get("fontSize"), null,
		"a desktop has the room for the terminal's default, and overriding it is not ours to do");
});

test("the option ttyd already needed is not lost either way", () => {
	for (const compact of [true, false]) {
		const url = new URL(webtermUrl(BASE, "webterm", compact));
		assert.equal(url.searchParams.get("disableLeaveAlert"), "true", `compact=${compact}`);
		assert.ok(url.pathname.endsWith("/"),
			"the trailing slash is what keeps Nginx from answering with a 301");
	}
});

test("the size is decided when the terminal opens, not when the page loads", () => {
	// The layout can change while the page is up and the terminal is not
	// reloaded to follow it -- reloading would drop the shell.
	const src = read("web/share/js/kvm/info.js");
	const hook = src.slice(src.indexOf("show_hook = function()"), src.indexOf("close_hook = function()"));
	assert.match(hook, /webtermUrl\(/, "the URL must be built inside show_hook");
	assert.match(hook, /data-ui/, "and it must read the layout at that moment");
});
