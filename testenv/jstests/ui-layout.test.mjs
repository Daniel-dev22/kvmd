// The layout is one attribute on <html>, resolved from the user's preference
// and one media query. Everything here is pure: no DOM, no navigator, no
// location -- which is also why switching styles can no longer reload the page.

import test from "node:test";
import assert from "node:assert/strict";
import {read} from "./helpers.mjs";
import {resolveUi, normalizePref, createUiSwitch, COMPACT_QUERY} from "../../web/share/js/ui.js";

test("an explicit preference always wins over the viewport", () => {
	assert.equal(resolveUi("desktop", true), "desktop");
	assert.equal(resolveUi("desktop", false), "desktop");
	assert.equal(resolveUi("mobile", false), "mobile");
	assert.equal(resolveUi("mobile", true), "mobile");
});

test("auto follows the viewport", () => {
	assert.equal(resolveUi("auto", true), "mobile");
	assert.equal(resolveUi("auto", false), "desktop");
});

test("an unknown or missing preference behaves as auto", () => {
	for (const pref of [null, undefined, "", "phone", "DESKTOP", 0]) {
		assert.equal(normalizePref(pref), "auto", `normalizePref(${JSON.stringify(pref)})`);
		assert.equal(resolveUi(pref, true), "mobile");
		assert.equal(resolveUi(pref, false), "desktop");
	}
});

test("the compact query tests width and pointer, never the user agent", () => {
	assert.match(COMPACT_QUERY, /max-width/);
	assert.match(COMPACT_QUERY, /pointer\s*:\s*coarse/);
	assert.doesNotMatch(COMPACT_QUERY, /iphone|android|ipad/i);
});

// A MediaQueryList stand-in. The real one is supplied by the page.
function fakeMql(matches) {
	const listeners = [];
	return {
		"matches": matches,
		"addEventListener": (_type, cb) => listeners.push(cb),
		"fire": function(next) {
			this.matches = next;
			listeners.forEach((cb) => cb({"matches": next}));
		},
	};
}
function fakeRoot() {
	return {
		"attrs": {},
		"setAttribute": function(name, value) {
			this.attrs[name] = value;
		},
	};
}

test("the switch stamps the resolved mode on the root element", () => {
	const root = fakeRoot();
	createUiSwitch({"root": root, "mql": fakeMql(true), "pref": "auto"});
	assert.equal(root.attrs["data-ui"], "mobile");
});

test("rotating or resizing re-resolves while the preference is auto", () => {
	const root = fakeRoot();
	const mql = fakeMql(false);
	createUiSwitch({"root": root, "mql": mql, "pref": "auto"});
	assert.equal(root.attrs["data-ui"], "desktop");
	mql.fire(true);
	assert.equal(root.attrs["data-ui"], "mobile", "auto must follow the viewport when it changes");
});

test("a forced preference is not overridden by a viewport change", () => {
	const root = fakeRoot();
	const mql = fakeMql(false);
	createUiSwitch({"root": root, "mql": mql, "pref": "desktop"});
	mql.fire(true);
	assert.equal(root.attrs["data-ui"], "desktop", "an explicit choice must survive a rotation");
});

test("changing the preference applies immediately", () => {
	const root = fakeRoot();
	const mql = fakeMql(true);
	const ui = createUiSwitch({"root": root, "mql": mql, "pref": "auto"});
	assert.equal(root.attrs["data-ui"], "mobile");
	ui.setPref("desktop");
	assert.equal(root.attrs["data-ui"], "desktop");
	assert.equal(ui.getPref(), "desktop");
	ui.setPref("auto");
	assert.equal(root.attrs["data-ui"], "mobile", "back to auto follows the viewport again");
});

test("switching the interface style cannot reload the page", () => {
	// kvm/main.js used to do window.location.href = window.location.href here,
	// which drops the stream, the HID socket and any half-filled form.
	assert.doesNotMatch(read("web/share/js/ui.js"), /location/,
		"ui.js must not touch window.location");
	assert.doesNotMatch(read("web/share/js/kvm/main.js"), /window\.location\.href\s*=/,
		"changing the interface style must not reload the session");
});
