// The keyboard is rendered twice -- a full desktop board and a layered compact
// board -- but DEFINED once. These tests hold that line.
//
// The file previously contained two hand-written boards, and they had already
// drifted: the mobile copy labelled Quote as a backtick, and 24 codes (the
// whole numpad, Power, and the Japanese block) existed only on desktop, so a
// phone could not send them at all.

import test from "node:test";
import assert from "node:assert/strict";
import {read} from "./helpers.mjs";

const HTML = read("web/kvm/index.html");
const PUG = read("web/kvm/window-keyboard.pug");

// The mouse window is a second Keypad instance; it is not part of the keyboard.
const slice = (fromId, toId) => HTML.slice(HTML.indexOf(`id="${fromId}"`), HTML.indexOf(`id="${toId}"`));
const DESKTOP = slice("keyboard-desktop", "keyboard-compact");
const COMPACT = slice("keyboard-compact", "mouse-window");

function labelled(chunk) {
	const out = new Map();
	const re = /data-keypad-code="([^"]+)"[^>]*>\s*<div class="label">(.*?)<\/div>/gs;
	for (const m of chunk.matchAll(re)) {
		out.set(m[1], m[2].replace(/\s+/g, " ").trim());
	}
	return out;
}
const desktop = labelled(DESKTOP);
const compact = labelled(COMPACT);

test("both boards are rendered, and neither is empty", () => {
	assert.ok(desktop.size > 100, `desktop board has ${desktop.size} keys`);
	assert.ok(compact.size > 100, `compact board has ${compact.size} keys`);
});

test("every key a desktop can send, a phone can send too", () => {
	const unreachable = [...desktop.keys()].filter((code) => !compact.has(code));
	assert.deepEqual(unreachable, [],
		`unreachable on a phone: ${unreachable.join(", ")}`);
});

test("the compact board invents no key the desktop lacks", () => {
	const extra = [...compact.keys()].filter((code) => !desktop.has(code));
	assert.deepEqual(extra, [], `only on the compact board: ${extra.join(", ")}`);
});

test("the two arrangements agree on every label", () => {
	// This is the assertion the old file would have failed: Quote read
	// `<br>' on the mobile copy and "<br>' on the desktop one.
	const disagree = [];
	for (const [code, label] of desktop) {
		if (compact.has(code) && compact.get(code) !== label) {
			disagree.push(`${code}: desktop ${JSON.stringify(label)} vs compact ${JSON.stringify(compact.get(code))}`);
		}
	}
	assert.deepEqual(disagree, [], `labels differ between arrangements:\n  ${disagree.join("\n  ")}`);
});

test("no code is repeated within a single arrangement", () => {
	for (const [name, chunk] of [["desktop", DESKTOP], ["compact", COMPACT]]) {
		const codes = [...chunk.matchAll(/data-keypad-code="([^"]+)"/g)].map((m) => m[1]);
		const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
		assert.deepEqual([...new Set(dupes)], [], `${name} board repeats: ${dupes.join(", ")}`);
	}
});

test("labels are written down exactly once, in the key table", () => {
	// The arrangements may only reference codes. If a label string appears
	// outside the KB_KEYS table, someone has started a second copy.
	const table = PUG.slice(PUG.indexOf("var KB_KEYS"), PUG.indexOf("var KB_LAYERS"));
	const body = PUG.slice(PUG.indexOf("var KB_LAYERS"));
    for (const marker of ['Caps Lock', 'NmLk', 'ScrLk', 'P/Brk', 'Pt/Sq']) {
		assert.ok(table.includes(marker), `${marker} should be defined in the key table`);
		assert.ok(!body.includes(marker),
			`"${marker}" appears outside the key table -- an arrangement is restating a label`);
	}
});

test("every compact row declares which layer it belongs to", () => {
	const rows = [...COMPACT.matchAll(/<div class="keypad-row"([^>]*)>/g)].map((m) => m[1]);
	const orphans = rows.filter((attrs) => !attrs.includes("data-keypad-layer="));
	assert.equal(orphans.length, 0, `${orphans.length} compact rows have no layer and would never be shown`);
});

test("every layer offered by the picker actually has rows", () => {
	const offered = [...HTML.matchAll(/data-keypad-layer-button="([^"]+)"/g)].map((m) => m[1]);
	assert.ok(offered.length >= 3, `only ${offered.length} layers offered`);
	for (const id of offered) {
		assert.ok(COMPACT.includes(`data-keypad-layer="${id}"`), `layer "${id}" has a button but no rows`);
	}
	// ...and no layer of rows is unreachable because it has no button.
	const present = new Set([...COMPACT.matchAll(/data-keypad-layer="([^"]+)"/g)].map((m) => m[1]));
	for (const id of present) {
		assert.ok(offered.includes(id), `layer "${id}" has rows but no button to reach it`);
	}
});
