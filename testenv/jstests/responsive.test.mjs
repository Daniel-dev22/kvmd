// 320 CSS px is the narrowest viewport we support (iPhone SE). A fixed width or
// min-width above that forces the page wider than the screen, and because
// div.window is `overflow: hidden` the excess is CLIPPED rather than scrollable
// -- controls become unreachable rather than merely awkward.

import test from "node:test";
import assert from "node:assert/strict";
import {read, cssFiles, jsFiles, declarationsOnly, PAGES} from "./helpers.mjs";

const NARROWEST = 320;

function rigidWidths(text) {
	const out = [];
	// The lookbehind keeps `max-width` out: a max-width never forces overflow.
	for (const m of declarationsOnly(text).matchAll(/(?<![-\w])(min-width|width)\s*:\s*(\d+)px/g)) {
		if (Number(m[2]) > NARROWEST) {
			out.push(`${m[1]}: ${m[2]}px`);
		}
	}
	return out;
}

for (const f of cssFiles()) {
	test(`${f} has no width wider than a phone`, () => {
		assert.deepEqual(rigidWidths(read(f)), [],
			`${f}: use min()/clamp()/% so the rule cannot exceed a ${NARROWEST}px viewport`);
	});
}

for (const page of PAGES) {
	test(`${page} has no inline width wider than a phone`, () => {
		const inline = [...read(page).matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
		assert.deepEqual(rigidWidths(inline), [], `${page}: inline style exceeds a ${NARROWEST}px viewport`);
	});
}

test("layout is not selected by sniffing the user agent", () => {
	// A UA sniff cannot see a 1280px tablet, a narrowed desktop window, or a
	// rotation. Width and pointer capability can; that is what must decide.
	const bb = read("web/share/js/bb.js");
	assert.doesNotMatch(bb, /is_mobile["']?\s*:\s*\(?[\s\S]{0,200}is_ios\s*\|\|\s*is_android/,
		"bb.js must not decide the layout from the user agent");
	for (const f of jsFiles()) {
		assert.doesNotMatch(read(f), /x-mobile\.css|x-desktop\.css/,
			`${f}: stylesheets must not be swapped at runtime -- the layout is one CSS attribute`);
	}
});

test("the per-user-agent stylesheets are gone", () => {
	for (const f of cssFiles()) {
		assert.ok(!/x-(mobile|desktop)\.css$/.test(f),
			`${f} still exists -- its rules belong in the base stylesheet under [data-ui]`);
	}
});
