const fs = require('fs');
const file = 'apps/photocraft-web/src/web.rs';
let code = fs.readFileSync(file, 'utf8');

// 1. Add imports after "use std::cell::Cell;"
code = code.replace(
  'use std::cell::Cell;',
  'use std::cell::Cell;\nuse std::cell::RefCell;\nuse std::rc::Rc;\nuse photocraft_engine::EngineError;\nuse photocraft_engine::Session;\nuse serde_json::Value;'
);

// 2. Add SESSION, REPAINT and bridge functions after "type Served = Arc<Mutex<ServedFonts>>;"
code = code.replace(
  'type Served = Arc<Mutex<ServedFonts>>;',
  `type Served = Arc<Mutex<ServedFonts>>;

// ============================================================
// AI Command Bridge: Global Session reference for JS
// ============================================================

/// Global Session reference for #[wasm_bindgen] functions.
static SESSION: Rc<RefCell<Option<Session>>> = Rc::new(RefCell::new(None));
/// UI repaint callback
static REPAINT: Rc<Cell<Option<fn()>>> = Rc::new(Cell::new(None));

fn store_session(session: Session) {
    *SESSION.borrow_mut() = Some(session);
}

fn store_repaint_callback(cb: fn()) {
    REPAINT.replace(Some(cb));
}

fn trigger_repaint() {
    if let Some(cb) = REPAINT.get() { cb(); }
}

fn execute_and_repaint(id: &str, params: Value) -> photocraft_engine::Result<Value> {
    let mut session = SESSION.borrow_mut();
    let Some(ref mut s) = *session else {
        return Err(EngineError::NoDocument);
    };
    let result = s.execute(id, params)?;
    trigger_repaint();
    Ok(result)
}

#[wasm_bindgen]
pub fn has_session() -> bool {
    SESSION.borrow().is_some()
}

#[wasm_bindgen]
pub fn execute_command(id: &str, params_json: &str) -> Result<String, String> {
    let params: Value = serde_json::from_str(params_json)
        .map_err(|e| format!("Invalid JSON params: {e}"))?;
    match execute_and_repaint(id, params) {
        Ok(result) => Ok(result.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[wasm_bindgen]
pub fn request_repaint() {
    trigger_repaint();
}`
);

// 3. Add store_session call after session is created
code = code.replace(
  'let (session, warnings) = crate::preset_bridge::session(presets.clone());',
  'let (session, warnings) = crate::preset_bridge::session(presets.clone());\n                store_session(session.clone());'
);

// 4. Add repaint callback after app.set_theme
code = code.replace(
  'app.set_theme(&cc.egui_ctx, ThemeKind::Pro);',
  'app.set_theme(&cc.egui_ctx, ThemeKind::Pro);\n                let ctx_clone = cc.egui_ctx.clone();\n                store_repaint_callback(move || { ctx_clone.request_repaint(); });'
);

fs.writeFileSync(file, code);
console.log('AI Bridge modifications applied successfully!');
