// Zettlr host bridge for the vendored Quiver fork. This file deliberately
// contains no diagram-editing implementation: Quiver owns that. It only maps
// parent-window messages to Quiver's public import/export/macro/theme surfaces.

window.__ZETTLR_QUIVER_HOST__ = true;

const [{ DOM }, { UI, load_katex }] = await Promise.all([
    import("./dom.mjs"),
    import("./ui.mjs"),
]);

await load_katex();

const body = new DOM.Element(document.body);
const ui = new UI(body);
ui.initialise();

// This fork is an editor embedded in a Markdown authoring environment, not
// Quiver's web publication surface. Force the output settings needed to keep
// the source as one raw tikzcd environment owned by the document.
ui.settings.set("quiver.renderer", "katex");
ui.settings.set("quiver.autosave", false);
ui.settings.set("export.centre_diagram", false);
ui.settings.set("export.standalone", false);

let session_id = null;
let suppress_change = false;
let emit_timer = null;
let fullscreen = false;

function post(message) {
    window.parent.postMessage({ ...message, sessionId: session_id }, "*");
}

function diagnostic_text(message) {
    if (!Array.isArray(message)) {
        return String(message ?? "");
    }
    return message.map((part) => {
        if (typeof part === "string") {
            return part;
        }
        return part?.element?.textContent ?? String(part ?? "");
    }).join("");
}

function serialise_diagnostics(diagnostics) {
    return diagnostics.map((diagnostic) => ({
        severity: diagnostic.constructor?.name?.includes("Warning") ? "warning" : "error",
        message: diagnostic_text(diagnostic.message),
        from: diagnostic.range?.start ?? 0,
        to: (diagnostic.range?.start ?? 0) + (diagnostic.range?.length ?? 0),
    }));
}

function strip_quiver_link(source) {
    // Quiver intentionally embeds a round-trip URL as the first comment of a
    // normal export. Zettlr persists the actual diagram state in the document,
    // so that web-share URL is redundant and would churn on every edit. In the
    // vendored iframe Quiver quite correctly uses its *current* URL as the
    // round-trip base (dev-server http://…/zettlr-host.html or packaged
    // file://…/zettlr-host.html), not q.uiver.app. Identify the generated line
    // by its encoded `q=` fragment rather than by a hosted-domain assumption.
    return source.replace(/^%\s+[^\n]*#[^\n]*q=[^\n]*\n/u, "");
}

function export_source() {
    const { data } = ui.quiver.export(
        "tikz-cd",
        ui.settings,
        ui.options(),
        ui.definitions(),
    );
    return strip_quiver_link(data).trim();
}

function load_source(source, macros, theme) {
    suppress_change = true;
    try {
        ui.reset();
        ui.settings.set("quiver.renderer", "katex");
        ui.settings.set("quiver.autosave", false);
        ui.settings.set("export.centre_diagram", false);
        ui.settings.set("export.standalone", false);
        const host_macros = macros !== null && typeof macros === "object" ? macros : {};
        ui.macro_text = null;
        ui.load_host_macros(host_macros);
        if (theme === "dark" || theme === "light") {
            ui.switch_theme(theme);
        }
        const { diagnostics } = ui.quiver.import(ui, "tikz-cd", source, ui.settings);
        post({
            type: "zettlr-quiver:loaded",
            diagnostics: serialise_diagnostics(diagnostics),
        });
    } catch (error) {
        post({
            type: "zettlr-quiver:error",
            message: error instanceof Error ? error.message : String(error),
        });
    } finally {
        suppress_change = false;
    }
}

window.addEventListener("zettlr-quiver-change", () => {
    if (suppress_change) {
        return;
    }
    if (emit_timer !== null) {
        clearTimeout(emit_timer);
    }
    // Label edits are deliberately collapsed by Quiver's History. A tiny
    // debounce mirrors that semantic boundary and avoids rewriting the
    // Markdown document on every internal render step.
    emit_timer = setTimeout(() => {
        emit_timer = null;
        try {
            post({ type: "zettlr-quiver:change", source: export_source() });
        } catch (error) {
            post({
                type: "zettlr-quiver:error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }, 40);
});

window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data === null || typeof event.data !== "object") {
        return;
    }
    const message = event.data;
    if (message.type === "zettlr-quiver:load") {
        session_id = message.sessionId;
        load_source(String(message.source ?? ""), message.macros ?? {}, message.theme);
    } else if (message.type === "zettlr-quiver:theme") {
        if (message.theme === "dark" || message.theme === "light") {
            ui.switch_theme(message.theme);
        }
    } else if (message.type === "zettlr-quiver:source") {
        load_source(String(message.source ?? ""), message.macros ?? {}, ui.theme);
    } else if (message.type === "zettlr-quiver:display") {
        fullscreen = message.fullscreen === true;
        document.body.classList.toggle("zettlr-fullscreen", fullscreen);
    }
});

// Escape must work while focus is inside the iframe; keyboard events do not
// bubble across frame boundaries.
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && fullscreen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        post({ type: "zettlr-quiver:close-request" });
        return;
    }

    // The parent owns file persistence, while Quiver's web build binds these
    // chords to import/export/share. Do not let those web-only actions open
    // hidden panes inside the embedded editor.
    if ((event.ctrlKey || event.metaKey) && ["e", "i"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);

post({ type: "zettlr-quiver:ready" });
