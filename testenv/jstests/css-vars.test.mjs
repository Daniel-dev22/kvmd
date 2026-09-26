// Every var() must resolve. An undeclared custom property fails silently: the
// whole declaration is dropped and the rule simply never applies, which is how
// --border-navbar-menu-top-thin sat broken in navbar.css unnoticed.

import test from "node:test";
import assert from "node:assert/strict";
import {declaredVars, usedVars} from "./helpers.mjs";

test("every referenced custom property is declared", () => {
	const declared = declaredVars();
	const missing = [];
	for (const [name, file] of usedVars()) {
		if (!declared.has(name)) {
			missing.push(`${name} (first used in ${file})`);
		}
	}
	assert.deepEqual(missing, [], `undeclared custom properties:\n  ${missing.join("\n  ")}`);
});
