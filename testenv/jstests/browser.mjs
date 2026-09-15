// A minimal Chrome DevTools Protocol client and static file server, so the
// layout tests can measure what a real engine actually renders.
//
// Deliberately dependency-free: node's built-in fetch, WebSocket and http are
// enough to drive headless Chromium. The only thing that has to be installed is
// a chromium binary, which the test image already needs for nothing else.

import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {ROOT} from "./helpers.mjs";

const CHROME_CANDIDATES = [
	process.env.CHROMIUM,
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome-stable",
	"/snap/bin/chromium",
];

const TYPES = {
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

// Serves web/ so that ES modules load. Modules are blocked over file://, and
// the pages under test are module-driven.
export async function serveWeb() {
	const server = createServer(async (req, res) => {
		const rel = decodeURIComponent(req.url.split("?")[0]);
		const file = path.join(ROOT, "web", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
		try {
			const body = await readFile(file);
			res.writeHead(200, {"Content-Type": TYPES[path.extname(file)] || "application/octet-stream"});
			res.end(body);
		} catch {
			// The kvmd API is not running; pages must still lay out without it.
			res.writeHead(404).end("not found");
		}
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		"origin": `http://127.0.0.1:${server.address().port}`,
		"close": () => new Promise((done) => server.close(done)),
	};
}

export async function launchBrowser() {
	const bin = chromiumPath();
	if (!bin) {
		throw new Error("no chromium binary found; set CHROMIUM=/path/to/chromium");
	}
	const profile = await mkdtemp(path.join(tmpdir(), "kvmd-jstest-"));
	const proc = spawn(bin, [
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--hide-scrollbars=false",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"about:blank",
	], {"stdio": ["ignore", "ignore", "pipe"]});

	const port = await new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`chromium did not start:\n${buf}`)), 30000);
		proc.stderr.on("data", (chunk) => {
			buf += chunk;
			const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		});
		proc.on("exit", (code) => reject(new Error(`chromium exited ${code}:\n${buf}`)));
	});

	return {
		"newPage": () => newPage(port),
		"close": async () => {
			proc.kill();
			await rm(profile, {"recursive": true, "force": true});
		},
	};
}

async function newPage(port) {
	// Creating the target over HTTP hands back a socket wired straight to the
	// page, which avoids all the Target/session plumbing.
	const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {"method": "PUT"});
	const target = await res.json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((done, fail) => {
		ws.onopen = done;
		ws.onerror = () => fail(new Error("could not attach to the page"));
	});

	let seq = 0;
	const pending = new Map();
	const waiters = [];
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const {resolve, reject} = pending.get(msg.id);
			pending.delete(msg.id);
			(msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
		} else if (msg.method) {
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].method === msg.method) {
					waiters.splice(i, 1)[0].resolve(msg.params);
				}
			}
		}
	};

	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, {resolve, reject});
		ws.send(JSON.stringify({id, method, params}));
	});
	const once = (method, ms = 20000) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
		waiters.push({method, "resolve": (p) => {
			clearTimeout(timer);
			resolve(p);
		}});
	});

	await send("Page.enable");
	await send("Runtime.enable");
	// Without this, a headless page is never "focused", so .focus() moves
	// document.activeElement but fires NO focus event -- and any behaviour
	// hanging off focus silently does nothing in tests while working fine in a
	// real browser. The instrument has to behave like the thing it stands in for.
	await send("Emulation.setFocusEmulationEnabled", {"enabled": true});

	return {
		"setViewport": (width, height, mobile = true) => send("Emulation.setDeviceMetricsOverride", {
			width, height, "deviceScaleFactor": 1, mobile,
		}),
		"clearStorage": async (origin) => {
			// localStorage is per-origin and survives navigation, so a test that
			// writes a preference would silently change the layout every later
			// test measures. Each page starts from a clean slate.
			const loaded = once("Page.loadEventFired");
			await send("Page.navigate", {"url": `${origin}/__blank`});
			await loaded;
			await send("Runtime.evaluate", {"expression": "try { localStorage.clear(); } catch (ex) {}"});
		},
		"goto": async (url) => {
			const loaded = once("Page.loadEventFired");
			await send("Page.navigate", {url});
			await loaded;
			// Give the module scripts their turn; they are deferred by spec.
			await new Promise((done) => setTimeout(done, 350));
		},
		// Touch has to be turned on explicitly: device metrics alone do not give
		// the page a touchscreen, and the media queries that decide the layout
		// (pointer: coarse, hover: none) answer differently once it does. Call
		// it BEFORE navigating, or the page bootstraps against the wrong answer.
		"setTouch": (enabled = true, points = 5) => send("Emulation.setTouchEmulationEnabled", {
			enabled, "maxTouchPoints": points,
		}),
		// A real touch, routed and hit-tested by the engine -- not a synthetic
		// TouchEvent handed straight to a listener, which would prove only that
		// the listener exists. For touchStart and touchMove, `points` is every
		// finger down; for touchEnd and touchCancel it is the points being
		// RELEASED, and an empty list means all of them -- so lifting one of
		// two fingers is touchEnd with just that one.
		"touch": (type, points = []) => send("Input.dispatchTouchEvent", {
			type,
			"touchPoints": points.map((p, i) => ({"x": p.x, "y": p.y, "id": (p.id === undefined ? i : p.id)})),
		}),
		// A real mouse, for the same reason. Dispatching a MouseEvent from
		// inside the page runs NO default action -- no focus change, no
		// suppression on a disabled control -- so a test written that way
		// cannot see the two mechanisms that made the OCR buttons inert with a
		// real pointer.
		"mouse": (type, x, y, button = "left", clicks = 1) => send("Input.dispatchMouseEvent", {
			type, x, y, button, "clickCount": clicks,
			"buttons": (type === "mouseReleased" || button === "none" ? 0 : 1),
		}),
		// A real pinch, through the compositor -- the browser's own gesture
		// recogniser, not two touch points we move apart and hope.
		"pinch": (x, y, scale) => send("Input.synthesizePinchGesture", {
			x, y, "scaleFactor": scale, "relativeSpeed": 800,
		}),
		// A real key, routed by the engine, so the editor performs its own
		// DEFAULT ACTION: Backspace actually removes a character from the focused
		// field and the page hears about it as input/deleteContentBackward. A
		// KeyboardEvent dispatched from inside the page does none of that, which
		// is precisely the mechanism the typing bar depends on.
		// `text` is what makes the engine INSERT the character: without it a key
		// is delivered but types nothing, which would silently turn every
		// assertion about typed text into an assertion about an empty field.
		// `modifiers` is CDP's bitmask -- Alt 1, Ctrl 2, Meta 4, Shift 8.
		"key": async (key, code, vk, {text = undefined, modifiers = 0} = {}) => {
			const ev = {key, code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, modifiers};
			await send("Input.dispatchKeyEvent", {
				"type": (text === undefined ? "rawKeyDown" : "keyDown"), ...ev,
				...(text === undefined ? {} : {text}),
			});
			await send("Input.dispatchKeyEvent", {"type": "keyUp", ...ev});
		},
		// What a soft keyboard does while a word is still being composed: the
		// engine's own IME path, so compositionstart/compositionupdate and the
		// insertCompositionText input events are the browser's, not ours. Calling
		// it again replaces the composing text, the way another letter does.
		"compose": (text) => send("Input.imeSetComposition", {
			text, "selectionStart": text.length, "selectionEnd": text.length,
		}),
		// Commits what is being composed, which is what a space or a punctuation
		// mark does on a phone. With nothing composing it just types the text.
		"commit": (text) => send("Input.insertText", {text}),
		"eval": async (expression) => {
			const out = await send("Runtime.evaluate", {
				expression, "returnByValue": true, "awaitPromise": true,
			});
			if (out.exceptionDetails) {
				throw new Error(out.exceptionDetails.exception?.description || "evaluate failed");
			}
			return out.result.value;
		},
		// A PNG of the layout as rendered. The measurements above say a box is
		// 390px wide; only this says whether it LOOKS right -- which for a phone
		// UI is most of the question.
		"screenshot": async (path) => {
			const out = await send("Page.captureScreenshot", {"format": "png"});
			await writeFile(path, Buffer.from(out.data, "base64"));
			return path;
		},
		"close": () => ws.close(),
	};
}

export const chromiumPath = () => CHROME_CANDIDATES.find((p) => p && existsSync(p)) || null;
