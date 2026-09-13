// Diagnostic, not a test -- the filename deliberately does not match
// *.test.mjs, so `node --test` does not pick it up.
//
//   node testenv/jstests/audit-menus.mjs
//
// Reports, for the compact and desktop layouts: whether the navbar strip
// scrolls (and therefore hides items past its edge), and whether each
// dropdown's content overflows the sheet it is in. The hardware-gated
// dropdowns (Switch, GPIO) are force-revealed, because a dev machine has
// no PiKVM Switch attached and they would otherwise be invisible here.
//
// NOTE: the ATX and Macro menus have no id -- they are bare `.hidden.menu`
// elements -- so anything that addresses menus by id will silently miss
// them. Address them as `ul#navbar li div.menu`.

import {serveWeb, launchBrowser} from "/docker_container_volumes/kvmd-mobile-first/testenv/jstests/browser.mjs";
const srv = await serveWeb(); const br = await launchBrowser();
const MENUS = ["system", "atx", "msd", "macro", "text", "shortcuts", "gpio", "switch"];

for (const [label, w, h, mobile] of [["COMPACT 390px", 390, 844, true], ["DESKTOP 1440px", 1440, 900, false]]) {
	const pg = await br.newPage();
	await pg.setViewport(w, h, mobile);
	await pg.clearStorage(srv.origin);
	await pg.goto(srv.origin + "/kvm/index.html");
	// The switcher and GPIO are hardware-gated; reveal them as a real device would.
	await pg.eval(`[...document.querySelectorAll("#navbar li")].forEach((el) => {
		el.classList.remove("feature-disabled"); el.classList.remove("hidden"); });`);
	const out = await pg.eval(`(() => {
		const nav = document.getElementById("navbar");
		const res = {navScroll: nav.scrollWidth, navClient: nav.clientWidth, items: [], menus: []};
		for (const li of nav.querySelectorAll("li")) {
			const b = li.getBoundingClientRect();
			const label = (li.querySelector("span") || {}).textContent || li.id || "?";
			res.items.push({label: label.trim().slice(0, 12), w: Math.round(b.width), visible: b.width > 0});
		}
		for (const id of ${JSON.stringify(MENUS)}) {
			const m = document.getElementById(id + "-menu");
			if (!m) { res.menus.push({id, missing: true}); continue; }
			m.classList.remove("hidden");
			const b = m.getBoundingClientRect();
			// Widest descendant that cannot shrink -- the thing forcing overflow.
			let worst = null;
			for (const el of m.querySelectorAll("*")) {
				const sw = el.scrollWidth, cw = el.clientWidth;
				if (cw > 0 && sw > cw + 1 && (!worst || sw - cw > worst.over)) {
					worst = {tag: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""),
						over: sw - cw, text: (el.textContent || "").trim().slice(0, 28)};
				}
			}
			res.menus.push({id, w: Math.round(b.width), scrollW: Math.round(m.scrollWidth),
				overflows: m.scrollWidth > Math.ceil(b.width) + 1, worst});
			m.classList.add("hidden");
		}
		return res;
	})()`);
	console.log(`=== ${label} ===`);
	console.log(`  navbar: scrollWidth ${out.navScroll} / client ${out.navClient}` +
		(out.navScroll > out.navClient ? "  (scrolls -- items past the edge)" : "  (all items fit)"));
	console.log("  items:", out.items.map((i) => i.label + (i.visible ? "" : "[HIDDEN]")).join(" | "));
	for (const m of out.menus) {
		if (m.missing) { console.log(`  ${m.id.padEnd(10)} MENU ELEMENT MISSING`); continue; }
		console.log(`  ${m.id.padEnd(10)} w=${String(m.w).padStart(4)} content=${String(m.scrollW).padStart(4)}` +
			(m.overflows ? `  OVERFLOWS by ${m.scrollW - m.w}px` : "  fits") +
			(m.worst ? `   worst: ${m.worst.tag} +${m.worst.over}px "${m.worst.text}"` : ""));
	}
	await pg.close();
}
await br.close(); await srv.close();
