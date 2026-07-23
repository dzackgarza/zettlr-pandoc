local system = require 'pandoc.system'
local home = os.getenv("HOME")
package.path = package.path .. ';' .. home .. '/.pandoc/filters/?.lua;'
require "utilities"

-- Logging helper: writes to stderr, no-op unless TIKZCD_DEBUG=1
local debug_mode = os.getenv("TIKZCD_DEBUG") == "1"
local function log(msg)
  if debug_mode then
    io.stderr:write("[tikzcd] " .. msg .. "\n")
  end
end

-- Output directories
local pandoc_dir = os.getenv("PANDOC_DIR") or (home .. "/.pandoc")
local figures_dir = os.getenv("FIGURES_DIR") or (home .. "/.pandoc/figures")
local svg_dir = os.getenv("SVG_DIR") or (figures_dir .. "/rendered")

-- Per-figure preamble template: the standalone LaTeX document each figure body is
-- wrapped in. It \usepackage's dzg-tikz, which \input's the broken-out macro files
-- (the single source of truth for tikz styles/defs — the same files the MathJax
-- path consumes), so the template carries the tikz macros directly; there is no
-- separate shared .tikzstyles/.tikzdefs palette. Defaults to the bundled template
-- under PANDOC_DIR (mirroring the PANDOC_DIR default above), overridable via
-- FIGURE_TEMPLATE_FILE. Read LAZILY at compile time (not at filter load) so the
-- doctor's empty-stdin invocation probe, which loads the filter but compiles no
-- figure, needs no render-context env. Returns (compiled_template,
-- raw_template_string): the raw string is folded into the figure cache key so
-- swapping the template content changes the render.
local function figure_template()
  local template_path = os.getenv("FIGURE_TEMPLATE_FILE")
  if not template_path or template_path == "" then
    template_path = pandoc_dir .. "/templates/standalone-tikz.tex"
  end
  local template_file = io.open(template_path, "r")
  if not template_file then
    error("tikzcd.lua: per-figure template not found at " .. template_path)
  end
  local template_str = template_file:read("*a")
  template_file:close()
  return pandoc.template.compile(template_str), template_str
end

-- Surface a figure-compile FAILURE to the app (Phase D / D-6 / P95). On a
-- pdflatex failure the standard LaTeX log carries a bang-error block: a `! …`
-- message line followed by an `l.NN  <source-prefix>` marker citing the line —
-- in the GENERATED `.tex` — that aborted the compile. This recovers that
-- diagnostic and writes ONE machine-parseable marker line per error to stderr so
-- it flows into the renderer subprocess stderr the app captures as
-- RenderResult.log (the figure-compile analog of the P11 pandoc log). The marker
-- carries the line WITHIN the figure body (the pdflatex `.tex` line minus the
-- preamble lines the template prepended before the figure source) and the EXACT
-- verbatim figure-body source line at that position, so the app can map it back
-- to the editor buffer's tikz SOURCE line. `figure_body` is the figure source the
-- `<>` marker was replaced with; `preamble_lines` is the count of `.tex` lines
-- BEFORE that source began. The parse contract is LaTeX's own bang-error format,
-- not a bespoke shape — the same `! …` / `l.NN` block pplatex consumes.
local function emit_figure_compile_error(log_path, figure_body, preamble_lines)
  local lf = io.open(log_path, "r")
  if not lf then
    return
  end
  local log_text = lf:read("*a")
  lf:close()

  local body_lines = {}
  for line in (figure_body .. "\n"):gmatch("(.-)\n") do
    body_lines[#body_lines + 1] = line
  end

  local emitted = false
  local log_lines = {}
  for line in (log_text .. "\n"):gmatch("(.-)\n") do
    log_lines[#log_lines + 1] = line
  end
  for i = 1, #log_lines do
    local message = log_lines[i]:match("^!%s*(.+)$")
    if message then
      -- The source line is cited later in the block by an `l.NN` marker.
      for j = i + 1, #log_lines do
        local tex_line = log_lines[j]:match("^l%.(%d+)")
        if tex_line then
          local body_line = tonumber(tex_line) - preamble_lines
          local src = body_lines[body_line]
          if src and src ~= "" then
            -- ONE marker line, pipe-delimited, source last (it is the only field
            -- that may contain a literal `|` in practice — tikz source rarely
            -- does — so the app splits on the FIRST two pipes only).
            io.stderr:write("[tikzcd-figure-error] " .. body_line .. "|" .. message .. "|" .. src .. "\n")
            emitted = true
          end
          break
        end
      end
    end
  end
  return emitted
end

-- Shared compilation core: given full LaTeX source, compile to PDF then SVG.
-- `figure_body` + `preamble_lines` let a FAILURE be surfaced to the app as a
-- mapped figure-compile diagnostic (Phase D / D-6 / P95). Returns
-- (svg_path, pdf_path) or (nil, nil) on failure.
local function run_pdflatex_and_convert(tex_source, tmp_prefix, hash, doc_dir, figure_body, preamble_lines)
  local svg_path = svg_dir .. "/dzgtikz-" .. hash .. ".svg"
  local pdf_path = svg_dir .. "/dzgtikz-" .. hash .. ".pdf"

  local sf = io.open(svg_path, "r")
  if sf then sf:close() end
  local pf = io.open(pdf_path, "r")
  if pf then pf:close() end
  if sf and pf then
    return svg_path, pdf_path
  end

  os.execute("mkdir -p " .. svg_dir)

  local tmp = "/tmp/" .. tmp_prefix .. "-" .. hash
  os.execute("mkdir -p " .. tmp)
  local tex_path = tmp .. "/tikz.tex"

  local f = io.open(tex_path, "w")
  f:write(tex_source)
  f:close()

  local inputs_env = ""
  local styles_dir = pandoc_dir .. "/styles//"
  if doc_dir and doc_dir ~= "" then
    inputs_env = "TEXINPUTS=" .. doc_dir .. ":" .. styles_dir .. ":: "
  else
    inputs_env = "TEXINPUTS=" .. styles_dir .. ":: "
  end

  -- Discard pdflatex's stdout+stderr: a pandoc filter's stdout is its output
  -- channel and must stay clean. The compile log would otherwise prepend to the
  -- rendered document, breaking a downstream `pandoc -f latex` re-parse of the
  -- output (the figure renders, but the log corrupts the stream). Diagnostics on
  -- failure come from the .log file via emit_figure_compile_error, not this stream.
  local cmd1 = inputs_env .. "pdflatex -interaction=nonstopmode -output-directory=" .. tmp .. " " .. tex_path .. " >/dev/null 2>&1"
  local ok1 = os.execute(cmd1)
  if not ok1 then
    -- Surface the figure-compile diagnostic (mapped to the figure source line)
    -- before tearing down the tmp dir, so the failure reaches the app instead of
    -- being dropped to a bare stderr note (Phase D / D-6 / P95).
    emit_figure_compile_error(tmp .. "/tikz.log", figure_body, preamble_lines)
    os.execute("rm -rf " .. tmp)
    return nil, nil
  end

  local tmp_pdf = tmp .. "/tikz.pdf"
  os.execute("cp " .. tmp_pdf .. " " .. pdf_path)
  local ok2 = os.execute("pdf2svg " .. tmp_pdf .. " " .. svg_path .. " >/dev/null 2>&1")
  os.execute("rm -rf " .. tmp)

  if not ok2 then
    return nil, pdf_path
  end

  return svg_path, pdf_path
end

local function resolve_inputs(text, base_dir, depth)
  if not depth then depth = 1 end
  if depth > 10 then
    log("resolve_inputs: max depth exceeded, potential circular input")
    return text
  end

  local count
  repeat
    count = 0
    text = text:gsub("\\input%s-{(.-)}", function(filename)
      count = count + 1
      local full_path = filename
      local is_absolute = filename:sub(1,1) == "/" or filename:match("^%a+:")
      if not is_absolute then
        full_path = base_dir .. "/" .. filename
      end

      local file = io.open(full_path, "r")
      if not file then
        -- If it doesn't end with .tikz or .tex, try appending extensions
        if not filename:match("%.%a+$") then
          file = io.open(full_path .. ".tikz", "r")
          if not file then
            file = io.open(full_path .. ".tex", "r")
          end
        end
      end

      if file then
        local content = file:read("*a")
        file:close()
        -- Recursively resolve inputs inside the loaded content
        return resolve_inputs(content, base_dir, depth + 1)
      else
        log("resolve_inputs: WARNING: could not open input file " .. filename)
        return "\\input{" .. filename .. "}"
      end
    end)
  until count == 0

  return text
end

-- Compile a tikz snippet (e.g. \begin{tikzcd}...) by wrapping it in the
-- config-declared per-figure template (Phase D / D-3 / P92) at its `<>` marker.
-- Returns (svg_path, pdf_path) or (nil, nil) on failure.
local function compile_tikz(source)
  local doc_path = os.getenv("PANDOC_DOC_PATH")
  local doc_dir = "."
  if doc_path and doc_path ~= "" then
    doc_dir = doc_path:match("(.+)[/\\]") or doc_dir
  end

  local resolved_source = resolve_inputs(source, doc_dir)

  -- The per-figure preamble template wraps this figure body; it \usepackage's
  -- dzg-tikz, so the broken-out macro files (styles/defs) are already in scope —
  -- no separate shared palette is wired in. Read lazily here.
  local tikz_doc_template, template_str = figure_template()

  -- The cache key (hash) folds in the TEMPLATE content as well as the figure body:
  -- the same body compiled against a different per-figure template (its bytes carry
  -- the dzg-tikz \usepackage / macro-file includes) is a different figure, so
  -- hashing only the body would return a stale cached SVG when the template
  -- changes.
  local hash = pandoc.sha1(resolved_source .. "\0" .. template_str)

  -- Substitute the figure source at the QTikz `<>` marker. The `<>` is plain text
  -- to pandoc's template engine (not a $...$ variable), so it survives the render
  -- untouched; substituting it AFTER keeps the figure source (which may contain
  -- `$` math) out of the pandoc-template pass entirely. A function replacement
  -- avoids gsub treating `%`/`\` in the source as special.
  local ctx = {}
  local rendered = pandoc.layout.render(pandoc.template.apply(tikz_doc_template, ctx))
  local marker_at = rendered:find("<>", 1, true)
  if not marker_at then
    error("tikzcd.lua: per-figure template carries no `<>` source marker (QTikz convention)")
  end
  -- The figure body begins on the SAME `.tex` line the `<>` marker sat on, so the
  -- preamble line count (lines strictly BEFORE the body) is the number of
  -- newlines in `rendered` before the marker (Phase D / D-6 / P95). A pdflatex
  -- `l.NN` cite minus this yields the 1-based line WITHIN the figure body.
  local preamble_lines = select(2, rendered:sub(1, marker_at - 1):gsub("\n", "\n"))
  local tex_source = rendered:gsub("<>", function() return resolved_source end)

  log("compile_tikz: hash=" .. hash .. " source_length=" .. #resolved_source)
  if debug_mode then
    local preview = resolved_source:sub(1, 200):gsub("\n", "\\n")
    log("compile_tikz: source_preview: " .. preview)
  end
  return run_pdflatex_and_convert(tex_source, "tikzcd", hash, doc_dir, resolved_source, preamble_lines)
end

-- Compile a full tikz document (from ```tikz code block) directly, no template.
-- Returns (svg_path, pdf_path) or (nil, nil) on failure.
local function compile_tikz_document(source)
  local doc_path = os.getenv("PANDOC_DOC_PATH")
  local doc_dir = "."
  if doc_path and doc_path ~= "" then
    doc_dir = doc_path:match("(.+)[/\\]") or doc_dir
  end

  local resolved_source = resolve_inputs(source, doc_dir)
  local hash = pandoc.sha1(resolved_source)
  -- A full-document tikz code block IS its own `.tex`: no template preamble is
  -- prepended, so a pdflatex `l.NN` cite is already the figure-body line.
  return run_pdflatex_and_convert(resolved_source, "tikzfull", hash, doc_dir, resolved_source, 0)
end

-- Shared helpers for building output from a compiled SVG/PDF pair.
local function make_latex_output(pdf_path, is_tikzcd)
  local base = pdf_path:gsub("%.pdf$", "")
  if is_tikzcd then
    return "\\begin{figure}[H]\n\\centering\n\\includesvg[width=\\columnwidth]{" .. base .. "}\n\\end{figure}"
  else
    return "\\begin{figure}\n\\centering\n\\includesvg[width=\\columnwidth]{" .. base .. "}\n\\end{figure}"
  end
end

local function namespace_svg_ids(svg_tag, prefix)
  -- Prefix all id="..." and xlink:href="#..." to prevent cross-SVG ID collisions
  -- when multiple inline SVGs share one HTML document.
  local result = svg_tag:gsub('id="([^"]*)"', 'id="' .. prefix .. '-%1"')
  result = result:gsub('xlink:href="#([^"]*)"', 'xlink:href="#' .. prefix .. '-%1"')
  return result
end

local function make_html_output(svg_path, css_class)
  local f = io.open(svg_path, "r")
  assert(f, "tikzcd.lua: SVG file missing after compilation: " .. svg_path)
  local svg_content = f:read("*a")
  f:close()

  local svg_tag = svg_content:match("<svg[^>]*>.-</svg>")
  if not svg_tag then
    svg_tag = svg_content
  end

  -- Namespace IDs using a short hash to prevent cross-SVG collisions
  local hash = pandoc.sha1(svg_tag):sub(1, 8)
  svg_tag = namespace_svg_ids(svg_tag, hash)

  local html = '<div style="text-align:center;">'
    .. '<span class="' .. css_class .. ' pandoc-preview-editable" data-edit-kind="' .. css_class .. '">'
    .. svg_tag
    .. '</span>'
    .. '</div>'
  return pandoc.Para(pandoc.RawInline('html', html))
end

if FORMAT:match 'latex' or FORMAT:match 'pdf' or FORMAT:match 'markdown' then
  function RawBlock(el)
    local is_tikzcd = starts_with('\\begin{tikzcd}', el.text)
    local is_tikzpic = starts_with('\\begin{tikzpicture}', el.text)
    if not is_tikzcd and not is_tikzpic then
      return el
    end

    log("RawBlock: processing " .. (is_tikzcd and "tikzcd" or "tikzpicture") .. " block, length=" .. #el.text)
    local _, pdf_path = compile_tikz(el.text)
    if not pdf_path then
      log("RawBlock: compilation FAILED for block")
      assert(pdf_path, "tikzcd.lua: compilation failed for tikz block")
    end
    log("RawBlock: compiled to " .. pdf_path)

    el.text = make_latex_output(pdf_path, is_tikzcd)
    return el
  end

  function CodeBlock(el)
    if not el.classes:includes("tikz") then
      return el
    end

    local _, pdf_path = compile_tikz_document(el.text)
    assert(pdf_path, "tikzcd.lua: compilation failed for tikz code block")

    return pandoc.RawBlock('latex', make_latex_output(pdf_path, false))
  end
end

if FORMAT:match 'html' then
  function RawBlock(el)
    local is_tikzcd = starts_with('\\begin{tikzcd}', el.text)
    local is_tikzpic = starts_with('\\begin{tikzpicture}', el.text)
    local is_pdftex = el.text:match("\\input%s-{(.-%.pdf_tex)}")
    if not is_tikzcd and not is_tikzpic and not is_pdftex then
      return el
    end

    log("RawBlock (html): processing tikz/pdftex block, length=" .. #el.text)
    local svg_path, _ = compile_tikz(el.text)
    if not svg_path then
      -- A figure that does NOT compile under the active per-figure template
      -- (Phase D / D-3 / P92: e.g. it requires a \usetikzlibrary the configured
      -- template omits) is ABSENT from the preview — it produces no <svg> — while
      -- the rest of the document still renders. The failure is loud in the filter
      -- log (and the figure visibly does not appear); dropping the single block,
      -- not aborting the whole render, is what makes a template swap observable in
      -- the live preview. Return the raw latex block unchanged: pandoc's HTML
      -- writer omits non-HTML raw blocks, so the failed figure leaves no element.
      io.stderr:write("[tikzcd] figure did not compile under the active per-figure template; omitting it from the preview\n")
      return el
    end
    log("RawBlock (html): compiled to " .. svg_path)

    local css_class = "tikzcd"
    if is_pdftex then
      css_class = "pdftex"
    elseif not is_tikzcd then
      css_class = "tikzpic"
    end

    return make_html_output(svg_path, css_class)
  end

  function CodeBlock(el)
    if not el.classes:includes("tikz") then
      return el
    end

    log("CodeBlock (html): processing tikz code block, length=" .. #el.text)
    local svg_path, _ = compile_tikz_document(el.text)
    if not svg_path then
      log("CodeBlock (html): compilation FAILED")
      assert(svg_path, "tikzcd.lua: compilation failed for tikz code block")
    end
    log("CodeBlock (html): compiled to " .. svg_path)

    return make_html_output(svg_path, "tikzcode")
  end
end
