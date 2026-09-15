// The terminal is somebody else's application in an iframe. Its type is sized
// by `zoom` on the iframe -- our side of the boundary -- rather than by asking
// ttyd for a font size, which was tried at 18px and 30px and reported both
// times from the phone as having no effect. What is left to check here is the
// URL, and that nothing has quietly re-added a font parameter that would
// multiply with the zoom.

import test from "node:test";
import assert from "node:assert/strict";
import {read} from "./helpers.mjs";
import {webtermUrl} from "../../web/share/js/kvm/webterm.js";

const BASE = "https://pikvm.example.net/";

test("the options ttyd actually needs are on the URL", () => {
	const url = new URL(webtermUrl(BASE, "webterm"));
	assert.equal(url.searchParams.get("disableLeaveAlert"), "true");
	assert.ok(url.pathname.endsWith("/"),
		"the trailing slash is what keeps Nginx from answering with a 301");
});

test("nothing asks ttyd for a font size any more", () => {
	// If this ever comes back, it multiplies with the zoom: a 2x zoom over a
	// 30px font is 60px, and the terminal would be four columns wide.
	assert.equal(new URL(webtermUrl(BASE, "webterm")).searchParams.get("fontSize"), null);
	assert.doesNotMatch(read("web/share/js/kvm/webterm.js"), /fontSize=/,
		"webterm.js must not put a font size on the URL");
});

test("the scale is declared where the terminal can be seen, and only in compact", () => {
	const css = read("web/share/css/kvm/stream.css");
	assert.match(css, /--webterm-scale/, "the scale factor has to exist");
	const compact = css.slice(css.indexOf("--webterm-scale"));
	assert.match(compact, /transform: scale\(var\(--webterm-scale\)\)/);
	assert.match(css, /:root\[data-ui="mobile"\] div#webterm-window \{/,
		"the factor must be scoped to the compact layout, or the desktop terminal is scaled too");
});
