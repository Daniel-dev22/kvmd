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
import {webtermUrl, webtermFontSize, WEBTERM_COLUMNS, WEBTERM_FONT_MIN_PX, WEBTERM_FONT_MAX_PX}
	from "../../web/share/js/kvm/webterm.js";

const BASE = "https://pikvm.example.net/";

test("a phone gets a font size it can read", () => {
	const url = new URL(webtermUrl(BASE, "webterm", 390));
	assert.equal(url.searchParams.get("fontSize"), String(webtermFontSize(390)));
	assert.ok(webtermFontSize(390) >= WEBTERM_FONT_MIN_PX,
		"xterm's own default is 15px -- anything near it changes nothing anyone can see");
});

test("the size is derived from the columns it has to leave, not chosen by eye", () => {
	// 0.6em per glyph, so `columns = width / (size * 0.6)`. Every phone width
	// must land within a column of the target, or the floor/ceiling must be
	// what stopped it.
	for (const width of [320, 360, 390, 414, 768]) {
		const size = webtermFontSize(width);
		const columns = width / (size * 0.6);
		const clamped = (size === WEBTERM_FONT_MIN_PX || size === WEBTERM_FONT_MAX_PX);
		assert.ok(clamped || Math.abs(columns - WEBTERM_COLUMNS) < 1,
			`${width}px gives ${columns.toFixed(1)} columns at ${size}px, and nothing clamped it`);
		assert.ok(size >= WEBTERM_FONT_MIN_PX && size <= WEBTERM_FONT_MAX_PX,
			`${width}px asked for ${size}px, outside the bounds`);
	}
});

test("a narrower phone gets fewer columns, never smaller type", () => {
	// The bounds are what stop the column target from being followed off a
	// cliff in either direction -- back to unreadable on a narrow phone, or to
	// a font meant for a watch on a tablet.
	assert.equal(webtermFontSize(200), WEBTERM_FONT_MIN_PX, "a very narrow screen must hit the floor");
	assert.equal(webtermFontSize(2000), WEBTERM_FONT_MAX_PX, "a very wide one must hit the ceiling");
	assert.ok(webtermFontSize(390) >= webtermFontSize(320),
		"a wider screen must never get smaller type");
});

test("the size a 390px phone actually gets", () => {
	// The number the device was judged on. If the constants move, this is the
	// reading that has to be re-taken on a phone rather than re-derived here.
	assert.equal(webtermFontSize(390), 30);
});

test("the desktop keeps the terminal's own default", () => {
	const url = new URL(webtermUrl(BASE, "webterm", null));
	assert.equal(url.searchParams.get("fontSize"), null,
		"a desktop has the room for the terminal's default, and overriding it is not ours to do");
});

test("the option ttyd already needed is not lost either way", () => {
	for (const width of [390, null]) {
		const url = new URL(webtermUrl(BASE, "webterm", width));
		assert.equal(url.searchParams.get("disableLeaveAlert"), "true", `width=${width}`);
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
