#!/usr/bin/env node
/**
 * PhotoCraft AI Command Bridge — apply to upstream source before build.
 *
 * Strategy: anchor-based insertion (not exact-string replacement).
 * Each anchor is a unique, stable line in the upstream source.
 * If an anchor is missing, the script exits with an error (no silent skip).
 *
 * What it does:
 *  1. Adds serde_json + futures-util to Cargo.toml [dependencies].
 *  2. Adds imports to web.rs.
 *  3. Adds AI Bridge globals (COMMAND_QUEUE, REPAINT, SESSION_READY) and
 *     #[wasm_bindgen] functions (execute_command, has_session, request_repaint).
 *  4. Registers the repaint callback + sets SESSION_READY in the start() closure.
 *  5. Processes the command queue in WebShell::logic().
 *
 * Why a command queue (not Rc<RefCell<Session>>):
 *  - Session is !Send, so Mutex<Session> is !Sync → cannot be in a static.
 *  - Rc<RefCell<Session>> is also !Sync → cannot be in a static.
 *  - The queue holds (String, Value, Arc<AtomicBool>, Arc<Mutex<Option<Result>>>)
 *    — all Send+Sync — so the static is valid on wasm32.
 *  - execute_command() is async: it pushes the request and yields; the eframe
 *    loop processes the queue on the next frame and resolves the Promise.
 */

const fs = require('fs');
const path = require('path');

const CARGO_TOML = 'apps/photocraft-web/Cargo.toml';
const WEB_RS = 'apps/photocraft-web/src/web.rs';
const INDEX_HTML = 'apps/photocraft-web/index.html';

function fatal(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function anchorReplace(code, anchor, insertion, label) {
  const idx = code.indexOf(anchor);
  if (idx === -1) {
    fatal(`Anchor not found: "${anchor.substring(0, 60)}..." (${label})`);
  }
  if (code.indexOf(anchor, idx + 1) !== -1) {
    fatal(`Anchor not unique: "${anchor.substring(0, 60)}..." (${label})`);
  }
  const end = idx + anchor.length;
  return code.slice(0, end) + insertion + code.slice(end);
}

function appendBefore(code, marker, block, label) {
  const idx = code.lastIndexOf(marker);
  if (idx === -1) {
    fatal(`Marker not found for prepend: "${marker.substring(0, 60)}..." (${label})`);
  }
  return code.slice(0, idx) + block + code.slice(idx);
}

// ── 1. Patch Cargo.toml ──────────────────────────────────────────────────────

const cargoPath = CARGO_TOML;
const cargoContent = fs.readFileSync(cargoPath, 'utf8');

// Check if serde_json is in [dependencies] (not [dev-dependencies])
const depSectionMatch = cargoContent.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
const depSection = depSectionMatch ? depSectionMatch[1] : '';
const hasSerdeRuntime = depSection.includes('serde_json');

if (hasSerdeRuntime) {
  console.log('  ↳ Cargo.toml already has serde_json in [dependencies]');
} else {
  // Insert after "log = { workspace = true }" inside [dependencies]
  const depAnchor = 'log = { workspace = true }';
  if (!cargoContent.includes(depAnchor)) {
    fatal('Cargo.toml anchor "log = { workspace = true }" not found');
  }
  const depIdx = cargoContent.indexOf(depAnchor);
  const depEnd = depIdx + depAnchor.length;
  const newDeps = `${depAnchor}\nserde_json = { workspace = true }\nfutures-util = "0.3"`;
  const patched = cargoContent.slice(0, depIdx) + newDeps + cargoContent.slice(depEnd);
  fs.writeFileSync(cargoPath, patched);
  console.log('  ↳ Added serde_json + futures-util to Cargo.toml [dependencies]');
}

// ── 2. Patch web.rs ──────────────────────────────────────────────────────────

const webPath = WEB_RS;
let code = fs.readFileSync(webPath, 'utf8');

// 2a. Add imports after "use std::sync::{Arc, Mutex};"
const importAnchor = 'use std::sync::{Arc, Mutex};';
if (!code.includes(importAnchor)) {
  fatal('web.rs import anchor "use std::sync::{Arc, Mutex};" not found');
}
const newImports = `use std::task::{Context, Poll};
use futures_util::future::poll_fn;
use serde_json::Value;
use wasm_bindgen::prelude::wasm_bindgen;`;
code = anchorReplace(code, importAnchor, `\n${newImports}`, 'imports');
console.log('  ↳ Added imports');

// 2b. Add globals after "type Served = Arc<Mutex<ServedFonts>>;"
const servedAnchor = 'type Served = Arc<Mutex<ServedFonts>>;';
if (!code.includes(servedAnchor)) {
  fatal('web.rs anchor "type Served = Arc<Mutex<ServedFonts>>;" not found');
}
const globalsBlock = `
// ============================================================
// AI Command Bridge: JS → engine command execution
// ============================================================

/// Pending command pushed by JS, polled by WebShell::logic() each frame.
type PendingCommand = (String, Value, Arc<AtomicBool>, Arc<Mutex<Option<Result<Value, String>>>>);

static COMMAND_QUEUE: Mutex<Vec<PendingCommand>> = Mutex::new(Vec::new());
static REPAINT: Mutex<Option<Box<dyn Fn() + Send>>> = Mutex::new(None);
static SESSION_READY: AtomicBool = AtomicBool::new(false);

/// Check if the PhotoCraft session is ready for command execution.
#[wasm_bindgen]
pub fn has_session() -> bool {
    SESSION_READY.load(Ordering::Relaxed)
}

/// Execute a PhotoCraft command from JavaScript.
/// Async: pushes the request to the queue, yields, and the eframe loop
/// processes it on the next frame.
#[wasm_bindgen]
pub async fn execute_command(id: &str, params_json: &str) -> Result<String, String> {
    let params: Value = serde_json::from_str(params_json)
        .map_err(|e| format!("Invalid JSON params: {e}"))?;

    let done = Arc::new(AtomicBool::new(false));
    let result = Arc::new(Mutex::new(None));

    COMMAND_QUEUE.lock().unwrap_or_else(|e| e.into_inner()).push((
        id.to_string(),
        params,
        done.clone(),
        result.clone(),
    ));

    // Poll the AtomicBool until the eframe loop sets it.
    poll_fn(|_cx: &mut Context<'_>| {
        if done.load(Ordering::Relaxed) {
            let r = result
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .unwrap_or(Err("command produced no result".into()));
            Poll::Ready(r.map(|v| v.to_string()))
        } else {
            Poll::Pending
        }
    })
    .await
}

/// Trigger a UI repaint so eframe re-render the canvas.
#[wasm_bindgen]
pub fn request_repaint() {
    if let Some(cb) = REPAINT.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        cb();
    }
}
`;
code = anchorReplace(code, servedAnchor, globalsBlock, 'globals');
console.log('  ↳ Added AI Bridge globals + #[wasm_bindgen] functions');

// 2c. Register repaint callback + SESSION_READY after app.set_theme()
const setThemeAnchor = 'app.set_theme(&cc.egui_ctx, ThemeKind::Pro);';
if (!code.includes(setThemeAnchor)) {
  fatal('web.rs anchor "app.set_theme(&cc.egui_ctx, ThemeKind::Pro);" not found');
}
const repaintRegistration = `
                    // AI Bridge: register repaint callback + mark session ready
                    let ctx_clone = cc.egui_ctx.clone();
                    {
                        let cb: Box<dyn Fn() + Send> = Box::new(move || ctx_clone.request_repaint());
                        *REPAINT.lock().unwrap_or_else(|e| e.into_inner()) = Some(cb);
                    }
                    SESSION_READY.store(true, Ordering::Relaxed);`;
code = anchorReplace(code, setThemeAnchor, repaintRegistration, 'repaint registration');
console.log('  ↳ Added repaint callback + SESSION_READY');

// 2d. Process command queue in WebShell::logic()
// Insert at the start of logic(), before the dropped-files handling.
const logicAnchor = 'fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {';
if (!code.includes(logicAnchor)) {
  fatal('web.rs anchor "fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {" not found');
}
const queueProcessing = `        // AI Bridge: process queued commands from JS
        {
            let commands = {
                let mut queue = COMMAND_QUEUE.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::take(&mut *queue)
            };
            for (id, params, done, result) in commands {
                let r = self.app.session.execute(&id, params).map_err(|e| e.to_string());
                *result.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
                done.store(true, Ordering::Relaxed);
            }
        }
`;
code = anchorReplace(code, logicAnchor, `\n${queueProcessing}`, 'queue processing');
console.log('  ↳ Added command queue processing in WebShell::logic()');

fs.writeFileSync(webPath, code);
console.log('✅ AI Bridge modifications applied successfully!');

// ── 3. Patch index.html (Trunk template) ────────────────────────────────────
// Trunk overwrites index.html on every build, so manual edits to the deployed
// output are futile. Instead, we inject the bridge shim and ai-widget.js into
// the Trunk TEMPLATE — every build picks it up automatically.
//
// What we inject:
//   A) A module script (after the Trunk-generated script) that exposes
//      window.execute_command / has_session / request_repaint from
//      window.wasmBindings, and sets up window.photocraft.hasImage()
//      via has_session().
//   B) <script src="../ai-widget.js"> before </body>.
//
// Timing: the bridge shim is a module script, so it runs after Trunk's
// generated script (which sets window.wasmBindings). ai-widget.js is a
// regular script that runs immediately — its init check may not see the
// bridge yet (badge won't light up), but every panel open re-checks.

const indexPath = INDEX_HTML;
const htmlContent = fs.readFileSync(indexPath, 'utf8');

// 3a) Inject bridge shim after the Trunk <link data-trunk> tag.
//     The link is replaced by Trunk with a generated module script; our
//     separate module script runs after it.
const trunkLinkAnchor = 'data-trunk';
if (!htmlContent.includes(trunkLinkAnchor)) {
  fatal('index.html anchor "data-trunk" not found');
}
const bridgeShim = `
<script type="module">
// AI Bridge API shim: expose Trunk wasm-bindgen exports on window.
// The Trunk-generated script uses await init(), so wasmBindings is set
// asynchronously. Listen for TrunkApplicationStarted to guarantee order.
window.addEventListener('TrunkApplicationStarted', () => {
    const b = window.wasmBindings;
    if (b && typeof b.execute_command === 'function') window.execute_command = b.execute_command;
    if (b && typeof b.has_session === 'function') window.has_session = b.has_session;
    if (b && typeof b.request_repaint === 'function') window.request_repaint = b.request_repaint;
    // window.photocraft.hasImage() — ai-widget.js uses this to detect the editor.
    // Use has_session() (bridge API) instead of the old canvas.toDataURL() hack.
    window.photocraft = {
        hasImage: () => { try { return b.has_session ? b.has_session() : false; } catch(e) { return false; } },
        apiVersion: 'bridge'
    };
});
</script>`;

// Check if the NEW shim (with TrunkApplicationStarted listener) is present.
// If not, inject it (removing any old shim first).
const hasNewShim = htmlContent.includes('TrunkApplicationStarted');

if (!hasNewShim) {
  // Remove old shim if present (check for the exact script tag start)
  let workingHtml = htmlContent;
  const oldShimStart = workingHtml.indexOf('<script type="module">\n// AI Bridge API shim');
  if (oldShimStart !== -1) {
    const oldShimEnd = workingHtml.indexOf('</script>', oldShimStart) + '</script>'.length;
    if (oldShimEnd !== -1) {
      workingHtml = workingHtml.slice(0, oldShimStart) + workingHtml.slice(oldShimEnd);
      console.log('  ↳ Removed old AI Bridge API shim');
    }
  }
  
  // Inject the new shim after the data-trunk link
  const trunkIdx = workingHtml.indexOf(trunkLinkAnchor);
  const lineEnd = workingHtml.indexOf('\n', trunkIdx);
  if (lineEnd === -1) {
    fatal('index.html: could not find end of data-trunk line');
  }
  const patchedHtml = workingHtml.slice(0, lineEnd + 1) + bridgeShim + '\n' + workingHtml.slice(lineEnd + 1);
  fs.writeFileSync(indexPath, patchedHtml);
  console.log('  ↳ Injected new AI Bridge API shim (TrunkApplicationStarted listener)');
} else {
  console.log('  ↳ index.html already has new AI Bridge API shim (TrunkApplicationStarted)');
}

// 3b) Inject <script src="../ai-widget.js"> before </body>
// NOTE: check for the actual script src attribute, NOT the bare string
// 'ai-widget.js', because the bridge shim comment above also mentions it.
const reloadedHtml = fs.readFileSync(indexPath, 'utf8');
if (!reloadedHtml.includes('src="../ai-widget.js"')) {
  const bodyClose = '</body>';
  if (!reloadedHtml.includes(bodyClose)) {
    fatal('index.html anchor "</body>" not found');
  }
  const widgetScript = '<script defer src="../ai-widget.js"></script>\n';
  const patchedHtml2 = reloadedHtml.replace(bodyClose, widgetScript + bodyClose);
  fs.writeFileSync(indexPath, patchedHtml2);
  console.log('  ↳ Injected <script src="../ai-widget.js"> into index.html');
} else {
  console.log('  ↳ index.html already has ai-widget.js reference');
}

// ── 4. Verification ──────────────────────────────────────────────────────────

const finalCode = fs.readFileSync(webPath, 'utf8');
const finalHtml = fs.readFileSync(indexPath, 'utf8');
const checks = [
  // web.rs checks
  ['serde_json::Value', 'serde_json import'],
  ['futures_util::future::poll_fn', 'poll_fn import'],
  ['COMMAND_QUEUE', 'command queue global'],
  ['SESSION_READY', 'session ready flag'],
  ['has_session', 'has_session() binding'],
  ['execute_command', 'execute_command() binding'],
  ['request_repaint', 'request_repaint() binding'],
  ['self.app.session.execute', 'queue processing in logic()'],
  // index.html checks
  ['AI Bridge API shim', 'bridge shim script in index.html'],
  ['src="../ai-widget.js"', 'ai-widget.js script tag in index.html'],
];

let allOk = true;
for (const [pattern, label] of checks) {
  // web.rs checks
  if (!finalCode.includes(pattern) && label !== 'bridge shim script in index.html' && label !== 'ai-widget.js script tag in index.html') {
    console.error(`  ❌ MISSING: ${label} ("${pattern}")`);
    allOk = false;
  }
  // index.html checks
  if (!finalHtml.includes(pattern) && (label === 'bridge shim script in index.html' || label === 'ai-widget.js script tag in index.html')) {
    console.error(`  ❌ MISSING: ${label} ("${pattern}")`);
    allOk = false;
  }
}

if (!allOk) {
  fatal('Verification failed — some expected patterns are missing');
}
console.log('✅ All verification checks passed');
