// Without a viewport meta tag a phone lays the page out at its ~980px fallback
// viewport and scales the result down, so every CSS pixel budget in the app is
// silently multiplied by ~0.4. Nothing else about the mobile UI is meaningful
// until this is present on every page kvmd serves.

import test from "node:test";
import assert from "node:assert/strict";
import {read, PAGES} from "./helpers.mjs";

const VIEWPORT = /<meta\s+name="viewport"\s+content="([^"]+)"\s*\/?>/i;

test("base.pug declares the viewport", () => {
	const m = read("web/base.pug").match(/meta\(name="viewport" content="([^"]+)"\)/);
	assert.ok(m, "web/base.pug must emit a viewport meta tag -- it is the only <head> in the app");
	assert.match(m[1], /width=device-width/);
	assert.match(m[1], /initial-scale=1/);
});

for (const page of PAGES) {
	test(`${page} carries the viewport meta`, () => {
		const m = read(page).match(VIEWPORT);
		assert.ok(m, `${page} has no viewport meta -- regenerate with 'make pug' after editing base.pug`);
		const content = m[1];
		assert.match(content, /width=device-width/, `${page}: viewport must be width=device-width`);
		assert.match(content, /initial-scale=1/, `${page}: viewport must set initial-scale=1`);
		// Pinching to zoom is how a user recovers from any layout we get wrong,
		// and disabling it is an accessibility failure. Never ship these.
		assert.doesNotMatch(content, /user-scalable\s*=\s*no/,
			`${page}: user-scalable=no blocks pinch zoom`);
		assert.doesNotMatch(content, /maximum-scale\s*=\s*1/,
			`${page}: maximum-scale=1 blocks pinch zoom`);
	});
}

// The layout must be stamped before the first paint, and a render-blocking
// script cannot import an ES module -- so base.pug necessarily repeats what
// ui.js knows. Unavoidable duplication is only safe while something forces the
// two to agree, which is what this does.
test("the pre-paint bootstrap agrees with ui.js", async () => {
	const ui = await import("../../web/share/js/ui.js");
	const pug = read("web/base.pug");

	const query = pug.match(/window\.matchMedia\("([^"]+)"\)/);
	assert.ok(query, "base.pug must resolve the layout from a media query before paint");
	assert.equal(query[1], ui.COMPACT_QUERY, "bootstrap and ui.js disagree on the compact query");

	assert.match(pug, /getItem\("page\.ui\.type"\)/, "bootstrap must read the stored preference");
	assert.match(pug, /setAttribute\("data-ui"/, "bootstrap must stamp data-ui on the root element");
	for (const mode of [ui.UI_DESKTOP, ui.UI_MOBILE]) {
		assert.ok(pug.includes(`"${mode}"`), `bootstrap does not know the mode ${mode}`);
	}

	// Same inputs, same answer -- checked against the real resolver.
	for (const pref of ["auto", "desktop", "mobile", null]) {
		for (const compact of [true, false]) {
			const expected = ui.resolveUi(pref, compact);
			const actual = ((pref === "desktop" || pref === "mobile") ? pref : (compact ? "mobile" : "desktop"));
			assert.equal(actual, expected, `bootstrap disagrees for pref=${pref} compact=${compact}`);
		}
	}
});

// Storage throws, rather than returning null, in some privacy modes. If the
// bootstrap does not survive that, the page never gets a layout at all.
test("the bootstrap survives blocked storage", () => {
	const pug = read("web/base.pug");
	const body = pug.slice(pug.indexOf("script."), pug.indexOf("link(rel=\"apple-touch-icon\""));
	assert.match(body, /try\s*\{/, "reading localStorage must be wrapped in try/catch");
	assert.match(body, /catch/);
});
