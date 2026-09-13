// Shared helpers for the web UI test suite.
//
// These tests assert properties of the SHIPPED artifacts -- the generated HTML,
// the stylesheets and the ES modules under web/ -- so a regression is caught
// whether it is introduced in a .pug source or by forgetting to run `make pug`.

import {readFileSync, readdirSync, statSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");

export function walk(rel, ext) {
	const base = path.join(ROOT, rel);
	const out = [];
	const rec = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = path.join(dir, name);
			if (statSync(full).isDirectory()) {
				rec(full);
			} else if (name.endsWith(ext)) {
				out.push(path.relative(ROOT, full));
			}
		}
	};
	rec(base);
	return out.sort();
}

// Every page kvmd serves. Generated from the matching .pug by `make pug`.
export const PAGES = [
	"web/index.html",
	"web/login/index.html",
	"web/kvm/index.html",
	"web/ipmi/index.html",
	"web/vnc/index.html",
];

export const cssFiles = () => walk("web/share/css", ".css");
export const jsFiles = () => walk("web/share/js", ".js");

// Strip comments and @media/@supports preludes so a declaration scan cannot
// mistake `@media (min-width: 900px)` for a `min-width: 900px` declaration.
export function declarationsOnly(css) {
	return css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/@(?:media|supports|-moz-document)[^{]*\{/g, "{");
}

// All custom properties DECLARED anywhere -- in a stylesheet, or inline on an
// element (a per-key grid span, for instance, is set on the element itself).
export function declaredVars() {
	const found = new Set();
	for (const f of [...cssFiles(), ...PAGES]) {
		for (const m of read(f).matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
			found.add(m[1]);
		}
	}
	return found;
}

// Custom properties referenced via var() WITHOUT a fallback. Those are the only
// ones that can fail to resolve -- and when one does, the whole declaration is
// dropped silently, which is how --border-navbar-menu-top-thin sat broken.
export function usedVars() {
	const found = new Map();
	for (const f of cssFiles()) {
		for (const m of read(f).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)/g)) {
			if (m[2] !== "," && !found.has(m[1])) {
				found.set(m[1], f);
			}
		}
	}
	return found;
}

// Attribute values of every element carrying `attr`, in document order.
export function attrValues(html, attr) {
	const out = [];
	for (const m of html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))) {
		out.push(m[1]);
	}
	return out;
}
