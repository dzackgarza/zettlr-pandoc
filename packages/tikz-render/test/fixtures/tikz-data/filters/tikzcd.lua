local ZETTLR_TIKZ_RENDER_PROTOCOL = 3
local system = require 'pandoc.system'
local pandoc_dir_env = os.getenv("PANDOC_DIR")
assert(pandoc_dir_env and pandoc_dir_env ~= "",
  "tikzcd.lua: PANDOC_DIR must point at the selected Pandoc data tree")
assert(os.getenv("SVG_DIR") and os.getenv("SVG_DIR") ~= "",
  "tikzcd.lua: SVG_DIR must point at the app-owned render cache")
local function starts_with(start, str)
  return str:sub(1, #start) == start
end

local debug_mode = os.getenv("TIKZCD_DEBUG") == "1"
local function log(msg)
  if debug_mode then
    io.stderr:write("[tikzcd] " .. msg .. "\n")
  end
end

local pandoc_dir = os.getenv("PANDOC_DIR")
local figures_dir = os.getenv("FIGURES_DIR") or (pandoc_dir .. "/figures")
local svg_dir = os.getenv("SVG_DIR")

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

  local log_lines = {}
  for line in (log_text .. "\n"):gmatch("(.-)\n") do
    log_lines[#log_lines + 1] = line
  end
  for i = 1, #log_lines do
    local message = log_lines[i]:match("^!%s*(.+)$")
    if message then
      for j = i + 1, #log_lines do
        local tex_line = log_lines[j]:match("^l%.(%d+)")
        if tex_line then
          local body_line = tonumber(tex_line) - preamble_lines
          local src = body_lines[body_line]
          if src and src ~= "" then
            io.stderr:write("[tikzcd-figure-error] " .. body_line .. "|" .. message .. "|" .. src .. "\n")
          end
          break
        end
      end
    end
  end

  io.stderr:write("[tikzcd-pdflatex-log-begin]\n")
  io.stderr:write(log_text)
  if not log_text:match("\n$") then
    io.stderr:write("\n")
  end
  io.stderr:write("[tikzcd-pdflatex-log-end]\n")
  return true
end

local function run_pdflatex_and_convert(tex_source, tmp_prefix, hash, doc_dir, figure_body, preamble_lines)
  local svg_path = svg_dir .. "/dzgtikz-" .. hash .. ".svg"
  local pdf_path = svg_dir .. "/dzgtikz-" .. hash .. ".pdf"

  local force_rebuild = os.getenv("TIKZ_FORCE_REBUILD") == "1"

  local sf = io.open(svg_path, "r")
  if sf then sf:close() end
  local pf = io.open(pdf_path, "r")
  if pf then pf:close() end
  if sf and pf and not force_rebuild then
    return svg_path, pdf_path
  end

  os.execute("mkdir -p " .. svg_dir)

  return system.with_temporary_directory(tmp_prefix .. "-" .. hash, function(tmp)
  local tex_path = tmp .. "/tikz.tex"

  local f = io.open(tex_path, "w")
  f:write(tex_source)
  f:close()

  local inputs_env = ""
  local styles_dir = os.getenv("FIGURE_STYLES_DIR") or (pandoc_dir .. "/styles")
  styles_dir = styles_dir:gsub("/+$", "") .. "//"
  local figures_dir = os.getenv("FIGURES_SOURCE_DIR") or (pandoc_dir .. "/figures")
  local figures_inputs = figures_dir:gsub("/+$", "") .. "//"
  if doc_dir and doc_dir ~= "" then
    inputs_env = 'TEXINPUTS="' .. doc_dir .. ':' .. styles_dir .. ':' .. figures_inputs .. '::" '
  else
    inputs_env = 'TEXINPUTS="' .. styles_dir .. ':' .. figures_inputs .. '::" '
  end

  local latex_command_log = tmp .. "/pdflatex-command.log"
  local cmd1 = inputs_env .. "pdflatex -interaction=nonstopmode -output-directory=" .. tmp .. " " .. tex_path .. " >" .. latex_command_log .. " 2>&1"
  local ok1, _, latex_exit = os.execute(cmd1)
  if not ok1 then
    if not emit_figure_compile_error(tmp .. "/tikz.log", figure_body, preamble_lines) then
      local command_file = io.open(latex_command_log, "r")
      local output = command_file and command_file:read("*a") or ""
      if command_file then command_file:close() end
      io.stderr:write("[tikzcd] pdflatex failed (exit " .. tostring(latex_exit) .. ") without a TeX log:\n" .. output .. "\n")
    end
    return nil, nil
  end

  local tmp_pdf = tmp .. "/tikz.pdf"
  local tmp_svg = tmp .. "/tikz.svg"
  os.execute("cp " .. tmp_pdf .. " " .. pdf_path)
  local conversion_log = tmp .. "/pdf2svg.log"
  local ok2, _, conversion_exit = os.execute("pdf2svg " .. tmp_pdf .. " " .. tmp_svg .. " >" .. conversion_log .. " 2>&1")
  if ok2 then
    local staged_svg = svg_path .. "." .. tmp:match("[^/]+$") .. ".new"
    local staged = os.execute("cp " .. tmp_svg .. " " .. staged_svg)
    if staged then
      ok2 = os.rename(staged_svg, svg_path)
    else
      ok2 = false
    end
    if not ok2 then
      os.remove(staged_svg)
    end
  end
  if not ok2 then
    local conversion_file = io.open(conversion_log, "r")
    if conversion_file then
      local conversion_text = conversion_file:read("*a")
      conversion_file:close()
      io.stderr:write("[tikzcd] pdf2svg failed (exit " .. tostring(conversion_exit) .. "):\n" .. conversion_text .. "\n")
    end
    return nil, pdf_path
  end

  return svg_path, pdf_path
  end)
end

local function try_open_file(candidate)
  local f = io.open(candidate, "r")
  if f then
    f:close()
    return candidate
  end
  return nil
end

local function check_path_and_extensions(base_path)
  local p = try_open_file(base_path)
  if p then return p end
  if not base_path:match("%.%a+$") then
    p = try_open_file(base_path .. ".tikz")
    if p then return p end
    p = try_open_file(base_path .. ".tikzcd")
    if p then return p end
    p = try_open_file(base_path .. ".tex")
    if p then return p end
  end
  return nil
end

local function find_input_file(filename, base_dir, figures_dir)
  if filename:sub(1,1) == "/" or filename:match("^%a+:") then
    return check_path_and_extensions(filename)
  end

  if base_dir and base_dir ~= "" then
    local p = check_path_and_extensions(base_dir .. "/" .. filename)
    if p then return p end
  end

  if figures_dir and figures_dir ~= "" then
    local p = check_path_and_extensions(figures_dir .. "/" .. filename)
    if p then return p end

    p = check_path_and_extensions(figures_dir .. "/tikz/" .. filename)
    if p then return p end

    p = check_path_and_extensions(figures_dir .. "/tikzcd/" .. filename)
    if p then return p end

    local sub_filename = filename:gsub("^tikz/", ""):gsub("^tikzcd/", "")
    for _, parent_name in ipairs({"tikz", "tikzcd", ""}) do
      local search_root = parent_name ~= "" and (figures_dir .. "/" .. parent_name) or figures_dir
      local ok, entries = pcall(pandoc.system.list_directory, search_root)
      if ok and entries then
        for _, entry in ipairs(entries) do
          local candidate = search_root .. "/" .. entry .. "/" .. sub_filename
          p = check_path_and_extensions(candidate)
          if p then return p end
        end
      end
    end
  end

  return nil
end

local function resolve_inputs(text, base_dir, depth)
  if not depth then depth = 1 end
  if depth > 10 then
    io.stderr:write("[tikzcd-figure-error] 1|Max input depth exceeded (potential circular input)|" .. text:sub(1, 80) .. "\n")
    error("tikzcd.lua: max depth exceeded, potential circular input")
  end

  local figures_dir = os.getenv("FIGURES_SOURCE_DIR") or (pandoc_dir .. "/figures")

  return text:gsub("\\input%s-{(.-)}", function(filename)
    local full_path = find_input_file(filename, base_dir, figures_dir)
    if not full_path then
      io.stderr:write("[tikzcd-figure-error] 1|Input file not found: " .. filename .. "|\\input{" .. filename .. "}\n")
      error("tikzcd.lua: input file not found: '" .. filename .. "'")
    end

    local file = io.open(full_path, "r")
    if not file then
      io.stderr:write("[tikzcd-figure-error] 1|Cannot open input file: " .. full_path .. "|\\input{" .. filename .. "}\n")
      error("tikzcd.lua: could not open input file: '" .. full_path .. "'")
    end

    local content = file:read("*a")
    file:close()
    return resolve_inputs(content, base_dir, depth + 1)
  end)
end

local function compile_tikz(source)
  local doc_path = os.getenv("PANDOC_DOC_PATH")
  local doc_dir = "."
  if doc_path and doc_path ~= "" then
    doc_dir = doc_path:match("(.+)[/\\]") or doc_dir
  end

  local resolved_source = resolve_inputs(source, doc_dir)

  local tikz_doc_template, template_str = figure_template()
  local render_context_hash = os.getenv("TIKZ_RENDER_CONTEXT_HASH") or ""

  local hash = pandoc.sha1(resolved_source .. "\0" .. template_str .. "\0" .. render_context_hash .. "\0" .. doc_dir)

  local ctx = {}
  local rendered = pandoc.layout.render(pandoc.template.apply(tikz_doc_template, ctx))
  local marker_at = rendered:find("<>", 1, true)
  if not marker_at then
    error("tikzcd.lua: per-figure template carries no `<>` source marker (QTikz convention)")
  end
  local preamble_lines = select(2, rendered:sub(1, marker_at - 1):gsub("\n", "\n"))
  local tex_source = rendered:gsub("<>", function() return resolved_source end)

  log("compile_tikz: hash=" .. hash .. " source_length=" .. #resolved_source)
  if debug_mode then
    local preview = resolved_source:sub(1, 200):gsub("\n", "\\n")
    log("compile_tikz: source_preview: " .. preview)
  end
  return run_pdflatex_and_convert(tex_source, "tikzcd", hash, doc_dir, resolved_source, preamble_lines)
end

local function compile_tikz_document(source)
  local doc_path = os.getenv("PANDOC_DOC_PATH")
  local doc_dir = "."
  if doc_path and doc_path ~= "" then
    doc_dir = doc_path:match("(.+)[/\\]") or doc_dir
  end

  local resolved_source = resolve_inputs(source, doc_dir)
  local render_context_hash = os.getenv("TIKZ_RENDER_CONTEXT_HASH") or ""
  local hash = pandoc.sha1(resolved_source .. "\0" .. render_context_hash .. "\0" .. doc_dir)
  return run_pdflatex_and_convert(resolved_source, "tikzfull", hash, doc_dir, resolved_source, 0)
end

local function make_latex_output(pdf_path, is_tikzcd)
  local base = pdf_path:gsub("%.pdf$", "")
  if is_tikzcd then
    return "\\begin{figure}[H]\n\\centering\n\\includesvg[width=\\columnwidth]{" .. base .. "}\n\\end{figure}"
  else
    return "\\begin{figure}\n\\centering\n\\includesvg[width=\\columnwidth]{" .. base .. "}\n\\end{figure}"
  end
end

local function namespace_svg_ids(svg_tag, prefix)
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
    local is_tikz = el.text:match("\\input%s-{%s*(.-%.tikz)%s*}") or el.text:match("\\input%s-{%s*(.-%.tikzcd)%s*}")
    if not is_tikzcd and not is_tikzpic and not is_tikz then
      return el
    end

    local is_cd = is_tikzcd or (is_tikz and is_tikz:match("%.tikzcd$") ~= nil)
    log("RawBlock: processing " .. (is_cd and "tikzcd" or "tikzpicture") .. " block, length=" .. #el.text)
    local _, pdf_path = compile_tikz(el.text)
    if not pdf_path then
      log("RawBlock: compilation FAILED for block")
      assert(pdf_path, "tikzcd.lua: compilation failed for tikz block")
    end
    log("RawBlock: compiled to " .. pdf_path)

    el.text = make_latex_output(pdf_path, is_cd)
    return el
  end

  function Para(el)
    if #el.content == 1 and el.content[1].t == 'RawInline' then
      local inline = el.content[1]
      if inline.format == 'tex' or inline.format == 'latex' then
        local raw = pandoc.RawBlock(inline.format, inline.text)
        local processed = RawBlock(raw)
        if processed ~= raw then
          return processed
        end
      end
    end
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
    local is_tikz = el.text:match("\\input%s-{%s*(.-%.tikz)%s*}") or el.text:match("\\input%s-{%s*(.-%.tikzcd)%s*}")
    if not is_tikzcd and not is_tikzpic and not is_pdftex and not is_tikz then
      return el
    end

    log("RawBlock (html): processing tikz/pdftex block, length=" .. #el.text)
    local svg_path, _ = compile_tikz(el.text)
    if not svg_path then
      return el
    end
    log("RawBlock (html): compiled to " .. svg_path)

    local css_class = "tikzcd"
    if is_pdftex then
      css_class = "pdftex"
    elseif is_tikz then
      css_class = is_tikz:match("%.tikzcd$") and "tikzcd" or "tikzpic"
    elseif not is_tikzcd then
      css_class = "tikzpic"
    end

    return make_html_output(svg_path, css_class)
  end

  function Para(el)
    if #el.content == 1 and el.content[1].t == 'RawInline' then
      local inline = el.content[1]
      if inline.format == 'tex' or inline.format == 'latex' then
        local raw = pandoc.RawBlock(inline.format, inline.text)
        local processed = RawBlock(raw)
        if processed ~= raw then
          return processed
        end
      end
    end
    return el
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
