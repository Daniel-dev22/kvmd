// A minimal Chrome DevTools Protocol client and static file server, so the
// layout tests can measure what a real engine actually renders.
//
// Deliberately dependency-free: node's built-in fetch, WebSocket and http are
// enough to drive headless Chromium. The only thing that has to be installed is
// a chromium binary, which the test image already needs for nothing else.

import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import {mkdir, mkdtemp, readdir, rm, stat} from "node:fs/promises";
import {homedir} from "node:os";
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

// ===========================================================================
// The websocket half of the fake appliance.
//
// Without it a test page has no kvmd behind it at all: `api/auth/check` 404s,
// the session never opens a socket, and the page sits OFFLINE for ever. That
// is the right default -- the pages must lay out with no backend -- but it
// leaves every behaviour that depends on being online untestable, and the bar
// refusing to type into a dead HID is exactly such a behaviour. A refusal with
// no instrument that can make it NOT fire is a refusal nobody can prove is
// conditional.
//
// Deliberately dependency-free, like the rest of this harness: RFC 6455 is a
// sha1 of the client's key and a two-byte header, and the page sends nothing
// fragmented and nothing over 125 bytes.
// ===========================================================================

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Server to client: never masked, and short enough that the two extended
// length forms are only here so a long keymap list cannot silently truncate.
function wsFrame(opcode, payload) {
	const len = payload.length;
	let head = null;
	if (len < 126) {
		head = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		head = Buffer.alloc(4);
		head.writeUInt8(0x80 | opcode, 0);
		head.writeUInt8(126, 1);
		head.writeUInt16BE(len, 2);
	} else {
		head = Buffer.alloc(10);
		head.writeUInt8(0x80 | opcode, 0);
		head.writeUInt8(127, 1);
		head.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([head, payload]);
}

// Client to server: always masked, and arriving in whatever chunks TCP felt
// like -- so a frame is only handed on once all of it is here. Returning on a
// short buffer without consuming it is what makes that work.
// Nothing the page sends is anywhere near this; a frame that claims to be is
// a decode that has gone wrong, and silently waiting for bytes that will never
// come turns into "the page never sent the key" three assertions later.
const WS_MAX_FRAME = 1 << 20;

function wsReader(onFrame) {
	let buf = Buffer.alloc(0);
	return function(chunk) {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			if (buf.length < 2) {
				return;
			}
			const fin = ((buf[0] & 0x80) !== 0);
			const opcode = (buf[0] & 0x0f);
			const masked = ((buf[1] & 0x80) !== 0);
			let len = (buf[1] & 0x7f);
			let off = 2;
			if (len === 126) {
				if (buf.length < 4) {
					return;
				}
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (buf.length < 10) {
					return;
				}
				len = Number(buf.readBigUInt64BE(2));
				off = 10;
			}
			if (len > WS_MAX_FRAME) {
				throw new Error(`the appliance stub decoded a ${len}-byte frame: the reader has lost sync`);
			}
			if (buf.length < off + (masked ? 4 : 0) + len) {
				return;
			}
			const mask = (masked ? buf.subarray(off, off + 4) : null);
			off += (masked ? 4 : 0);
			const payload = Buffer.from(buf.subarray(off, off + len));
			if (mask !== null) {
				for (let i = 0; i < len; i++) {
					payload[i] ^= mask[i & 3];
				}
			}
			buf = buf.subarray(off + len);
			if (!fin || opcode === 0x0) {
				// Nothing here sends anything big enough to fragment, so a
				// fragment means the decode is wrong -- and quietly handing on
				// half a frame would put a mis-read key in the host record.
				throw new Error("the appliance stub received a fragmented frame, which nothing should send");
			}
			onFrame(opcode, payload);
		}
	};
}

// The HID state kvmd streams, with the fields the page actually reads. Sent in
// FULL on every change, because that is what kvmd does (`poll_state` yields
// `get_state()` whole) and because hid.js assigns `state.keyboard.leds`
// unconditionally -- a partial event would leave it undefined and throw.
export function hidState(patch = {}) {
	const state = {
		"enabled": true,
		"online": true,
		"busy": false,
		"connected": null,
		"keyboard": {
			"online": true,
			"leds": {"caps": false, "scroll": false, "num": false},
			"outputs": {"available": [], "active": ""},
		},
		"mouse": {
			"online": true,
			"absolute": true,
			"outputs": {"available": [], "active": ""},
		},
		"jiggler": {"enabled": false, "active": false, "interval": 60},
	};
	return merged(state, patch);
}

// A patch says what CHANGED, so `{"keyboard": {"online": false}}` has to keep
// the LEDs it did not mention: hid.js assigns `state.keyboard.leds` whether or
// not the event carried one, and an undefined one throws on the next read.
function merged(base, patch) {
	const out = {...base};
	for (const [key, value] of Object.entries(patch)) {
		out[key] = (
			(isPlain(value) && isPlain(base[key]))
				? merged(base[key], value)
				: value
		);
	}
	return out;
}

const isPlain = (v) => (v !== null && typeof v === "object" && !Array.isArray(v));

// Serves web/ so that ES modules load. Modules are blocked over file://, and
// the pages under test are module-driven.
export async function serveWeb() {
	// Everything the page sends to api/hid/print, in order, so a test can read
	// what the host would have received.
	const printed = [];
	// The same thing from the HOST's side, and across BOTH transports: text
	// arrives over HTTP and keys over the websocket, so a claim about the order
	// between them -- "the latched Ctrl was let go before the text was typed"
	// -- cannot be read from either one alone. Recorded on ARRIVAL, whatever
	// the answer is going to be, because that is when the host would have seen
	// it: `control.printStatus` decides only what is said back.
	const host = [];
	// Mutable so a test can make the host slow or broken; reset per test.
	//
	// `session` is off by default: with no kvmd behind it the page must still
	// lay out, which is what nearly every test measures. A test that needs the
	// page ONLINE turns it on BEFORE navigating -- or at any later moment, and
	// the page's own reconnect loop picks it up within about a second.
	// `hidSnapshot` is what kvmd does on connect -- the whole state, at once.
	// A test can withhold it to measure what the page ASSUMES about a HID it
	// has not been told anything about yet.
	// What a replayed script asked the appliance to do that is NOT keyboard or
	// mouse. Recorded separately because "Mute KB/M" deliberately does not
	// cover it -- an ATX press muted is a press that must still happen -- and
	// there is no way to tell that from `host`, which is the HID's record.
	const atx = [];
	// `printAbort` kills the connection instead of answering, which is the only
	// way to give the page an XHR with `status === 0` -- a request that DIED,
	// as opposed to one that was refused before it left. The page has to tell
	// those apart: kvmd may have typed all of it.
	const control = {
		"printStatus": 200, "printDelayMs": 0, "printAbort": false,
		"session": false, "hidSnapshot": true,
	};
	let hid = hidState();
	const sockets = new Set();

	const sendJson = (sock, ev_type, ev) => sock.write(
		wsFrame(0x1, Buffer.from(JSON.stringify({"event_type": ev_type, "event": ev}), "utf-8")));
	const server = createServer(async (req, res) => {
		const rel = decodeURIComponent(req.url.split("?")[0]);
		// What the session asks before it opens the socket. A 404 here is how
		// this harness keeps the page offline by default.
		if (rel.endsWith("/api/auth/check")) {
			if (!control.session) {
				res.writeHead(404).end("not found");
				return;
			}
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(JSON.stringify({"ok": true, "result": {}}));
			return;
		}
		// The ONE endpoint that has to answer. Everything else in kvmd's API is
		// allowed to 404 here -- the pages lay out without it -- but a print
		// that 404s exercises the queue's FAILURE path, which now discards
		// what is queued behind it. The suite was measuring that failure path
		// while asserting about the success one, and losing characters to it.
		if (rel.endsWith("/api/hid/print") || rel === "/api/hid/print") {
			const chunks = [];
			for await (const chunk of req) {
				chunks.push(chunk);
			}
			const body = Buffer.concat(chunks).toString("utf-8");
			printed.push({"body": body, "url": req.url});
			host.push(`print ${JSON.stringify(body)}`);
			// A stub that can only succeed makes the queue's whole failure path
			// -- and the 200 check that feeds it -- unreachable from the browser
			// suite, so a build reporting every failure as success passes. And
			// one that answers instantly makes "in flight" sub-millisecond,
			// which is the window every ordering claim lives in.
			if (control.printDelayMs > 0) {
				await new Promise((done) => setTimeout(done, control.printDelayMs));
			}
			if (control.printAbort) {
				req.socket.destroy();
				return;
			}
			if (control.printStatus !== 200) {
				res.writeHead(control.printStatus).end("nope");
				return;
			}
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(JSON.stringify({"ok": true, "result": {}}));
			return;
		}
		if (rel.endsWith("/api/atx/click")) {
			atx.push(req.url);
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(JSON.stringify({"ok": true, "result": {}}));
			return;
		}
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

	server.on("upgrade", (req, sock, head) => {
		const rel = req.url.split("?")[0];
		const key = req.headers["sec-websocket-key"];
		if (!control.session || !rel.endsWith("/api/ws") || !key) {
			sock.destroy();
			return;
		}
		sock.write(
			"HTTP/1.1 101 Switching Protocols\r\n"
			+ "Upgrade: websocket\r\nConnection: Upgrade\r\n"
			+ `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WS_GUID).digest("base64")}\r\n\r\n`);
		sockets.add(sock);
		sock.on("close", () => sockets.delete(sock));
		sock.on("error", () => sockets.delete(sock));
		const read = wsReader(function(opcode, payload) {
			if (opcode === 0x8) { // Close
				sock.end(wsFrame(0x8, Buffer.alloc(0)));
				return;
			}
			if (opcode === 0x9) { // Ping
				sock.write(wsFrame(0xA, payload));
				return;
			}
			if (opcode !== 0x2 || payload.length === 0) {
				return;
			}
			if (payload[0] === 0) {
				// The session's own heartbeat. Fifteen unanswered ones and the
				// page tears the socket down and reconnects, which would make
				// anything measured over more than 15s a test of this reply.
				sock.write(wsFrame(0x2, Buffer.from([255])));
				return;
			}
			if (payload[0] === 1) { // Key, "\x01" + state + the code, in ASCII
				host.push(`key ${payload.subarray(2).toString("ascii")} ${(payload[1] & 1) ? "down" : "up"}`);
			} else if (payload[0] === 2) { // Mouse button, same shape
				host.push(`mouse ${payload.subarray(2).toString("ascii")} ${(payload[1] & 1) ? "down" : "up"}`);
			}
			// Moves, wheels and relative deltas are deliberately not recorded:
			// a single drag is hundreds of them and would bury everything else.
		});
		sock.on("data", read);
		// Bytes that arrived in the same segment as the handshake. Node hands
		// them over separately and they are never re-emitted as data; dropping
		// them would lose a frame and blame the page for not sending it.
		if (head && head.length > 0) {
			read(head);
		}
		// kvmd sends the whole state the moment the socket opens, so the page
		// is never left guessing what it is connected to.
		if (control.hidSnapshot) {
			sendJson(sock, "hid", hid);
		}
		sendJson(sock, "hid_keymaps", {"keymaps": {"default": "en-us", "available": ["en-us", "de"]}});
	});

	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return {
		"origin": `http://127.0.0.1:${server.address().port}`,
		"printed": printed,
		"host": host,
		"atx": atx,
		// Waits for what the host was expected to receive rather than sleeping
		// a guessed number of milliseconds -- long enough on an idle machine
		// and not on one running four browsers at once. An expectation of
		// NOTHING has to wait out the whole window, since there is no event to
		// wait for; and the grace period after it is what lets an event that
		// should NOT have followed show up in the assertion instead of being
		// missed by a race.
		// 📏 The budget is generous on purpose. A positive wait returns the
		// moment the count is reached, so it costs nothing when the machine is
		// quiet -- and on a machine under someone else's build it is the
		// difference between a real answer and an empty list. Measured: this
		// suite was run at load average 226 and read three events as none.
		"waitHost": async (want, ms = 5000) => {
			const until = Date.now() + ms;
			while (Date.now() < until && (want <= 0 || host.length < want)) {
				await new Promise((done) => setTimeout(done, 25));
			}
			await new Promise((done) => setTimeout(done, 150));
			return host.slice();
		},
		"control": control,
		// A new HID state, pushed to whoever is connected. `patch` is merged
		// one level deep over the healthy default, so a test says what it is
		// changing -- `{"keyboard": {"online": false}}` for an unenumerated
		// gadget -- and gets a FULL event, which is what kvmd sends.
		"setHid": (patch = {}) => {
			hid = hidState(patch);
			for (const sock of sockets) {
				sendJson(sock, "hid", hid);
			}
		},
		// The link dropping, as opposed to the HID going offline behind it.
		"dropSession": () => {
			control.session = false;
			for (const sock of sockets) {
				sock.destroy();
			}
			sockets.clear();
		},
		"reset": () => {
			printed.length = 0;
			host.length = 0;
			atx.length = 0;
			control.printStatus = 200;
			control.printDelayMs = 0;
			control.printAbort = false;
			control.session = false;
			control.hidSnapshot = true;
			hid = hidState();
			for (const sock of sockets) {
				sock.destroy();
			}
			sockets.clear();
		},
		"close": () => new Promise((done) => {
			for (const sock of sockets) {
				sock.destroy();
			}
			sockets.clear();
			server.close(done);
		}),
	};
}

// ===========================================================================
// Driving the page: the three expressions every gesture test needs. They live
// here rather than in one suite because a second copy of "where is this key"
// is how two suites end up disagreeing about what a tap is.
// ===========================================================================

// A touch is dispatched at coordinates, so a target that is not on screen does
// not fail -- it silently aims at 0,0, which is the back link in the navbar, and
// the page navigates away mid-test. The instrument refuses instead.
export const centre = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (el === null) { throw new Error("no element for " + ${JSON.stringify(selector)}); }
	// A key can be in the DOM, sized, and still outside what is on screen --
	// inside a sheet that is scrolled, or below the fold -- and a touch
	// dispatched at its "centre" then lands on whatever is at those
	// coordinates instead, silently. A user reaches it by scrolling; so does
	// this.
	el.scrollIntoView({"block": "nearest", "inline": "nearest"});
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) {
		throw new Error(${JSON.stringify(selector)} + " is not on screen: nothing to touch");
	}
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
		throw new Error(${JSON.stringify(selector)} + " is outside the viewport even after scrolling: "
			+ JSON.stringify({x, y}));
	}
	return {"x": x, "y": y, "w": r.width, "h": r.height};
})()`;

export const classOf = (selector) => `document.querySelector(${JSON.stringify(selector)}).className`;

export async function tap(pg, point, hold = 0) {
	await pg.touch("touchStart", [point]);
	if (hold > 0) {
		await new Promise((done) => setTimeout(done, hold));
	}
	await pg.touch("touchEnd", []);
}

// Waits until the page has actually connected to the appliance stub and been
// told its HID is ready.
//
// The keyboard LED is the page's own answer to "can this reach the host", and
// its title distinguishes all three states: free/captured (ready), "emulator
// offline" (no HID at all) and "inactive/busy" (the gadget is not enumerated).
// Without waiting, a test types into a page that has not finished connecting
// and measures the OFFLINE path by accident -- passing, for the wrong reason.
export async function waitOnline(pg, ms = 5000) {
	const until = Date.now() + ms;
	for (;;) {
		const link = await pg.eval(`document.getElementById("link-led").className`);
		const kbd = await pg.eval(`document.getElementById("hid-keyboard-led").title`);
		if (link === "led-green" && !kbd.includes("offline") && !kbd.includes("inactive")) {
			return;
		}
		if (Date.now() > until) {
			throw new Error(`the page never came online: link=${link} keyboard=${kbd}`);
		}
		await new Promise((done) => setTimeout(done, 50));
	}
}

// Where a browser's throwaway profile lives, and why it is not /tmp.
//
// 🔴 `/tmp` on this machine is TMPFS -- every byte a profile holds is RAM --
// and snap confinement makes cleaning it impossible rather than merely
// wasteful: a snap-packaged chromium has its own private /tmp, so
// `--user-data-dir=/tmp/x` puts the real profile in
// `/tmp/snap-private-tmp/snap.chromium/tmp/x` while this process deletes an
// empty stub at `/tmp/x`. That directory is root-owned and `drwx------`, so
// the harness cannot reach it even to try.
//
// 📏 It therefore leaked on the HAPPY path, not just when a run threw: 285
// profiles, 5.4 GB of RAM, accumulated over three days and filled swap on a
// 30 GB box. A `finally { close() }` would not have saved it.
//
// Under $HOME instead: snap's `home` interface is not redirected, and this
// filesystem is ext4, so a leak costs disk rather than memory.
//
// ⚠ NOT `~/.cache`, which is where this obviously belongs. 📏 Measured: snap's
// `home` interface does not grant HIDDEN directories, so chromium dies with
// `Failed to create .../SingletonLock: Permission denied` before it opens a
// port. The directory has to be one a snap may write, which means a visible
// one.
const PROFILES = path.join(homedir(), "kvmd-jstest-profiles");

// SIGKILL defeats every cleanup handler there is, and a suite run under a test
// timeout is killed exactly that way -- so the only reliable cleanup is one
// that runs at the START of the next run. Anything older than the window no
// suite run can outlive is nobody's.
const STALE_MS = 6 * 3600 * 1000;

async function profileBase() {
	await mkdir(PROFILES, {"recursive": true});
	const now = Date.now();
	for (const name of await readdir(PROFILES).catch(() => [])) {
		const full = path.join(PROFILES, name);
		// A concurrent run's profile is minutes old, not hours; its mtime moves
		// while the browser is writing. Anything past the window was abandoned.
		const when = await stat(full).then((st) => st.mtimeMs).catch(() => now);
		if (now - when > STALE_MS) {
			await rm(full, {"recursive": true, "force": true}).catch(() => {});
		}
	}
	return PROFILES;
}

export async function launchBrowser() {
	const bin = chromiumPath();
	if (!bin) {
		throw new Error("no chromium binary found; set CHROMIUM=/path/to/chromium");
	}
	const profile = await mkdtemp(path.join(await profileBase(), "run-"));
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

	const started = new Promise((resolve, reject) => {
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

	// Everything below owns the profile through close(). Until then nothing
	// does, and a browser that never starts is exactly when a run is abandoned
	// -- which is how the directory this sweeps came to exist in the first
	// place.
	let port;
	try {
		port = await started;
	} catch (ex) {
		proc.kill("SIGKILL");
		await rm(profile, {"recursive": true, "force": true}).catch(() => {});
		throw ex;
	}

	return {
		"newPage": () => newPage(port),
		"close": async () => {
			// Waited for, not merely signalled. kill() returns the instant the
			// signal is sent and chromium goes on writing its profile for a
			// while after -- so removing it here raced, and lost with
			// ENOTEMPTY. It never showed before this profile moved out of
			// /tmp, because under snap confinement the directory being removed
			// was an empty stub and the real one was unreachable.
			const stopped = new Promise((done) => proc.once("exit", done));
			proc.kill("SIGTERM");
			const forced = setTimeout(() => proc.kill("SIGKILL"), 5000);
			await stopped;
			clearTimeout(forced);
			// maxRetries covers the last writes of a child that outlived its
			// parent by a few milliseconds. force, so a profile already gone is
			// not an error -- the sweep at the next launch may have taken it.
			await rm(profile, {"recursive": true, "force": true, "maxRetries": 5, "retryDelay": 100});
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
