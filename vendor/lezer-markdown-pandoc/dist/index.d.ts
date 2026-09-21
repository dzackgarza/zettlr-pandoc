import { PartialParse, Tree, NodeType, NodePropSource, ParseWrapper, Parser, NodeSet, Input, TreeFragment } from '@lezer/common';
import { Tag } from '@lezer/highlight';
import { InlineParser as InlineParser$1 } from './markdown';

/**
Data structure used to accumulate a block's content during [leaf
block parsing](#BlockParser.leaf).
*/
declare class LeafBlock {
    /**
    The start position of the block.
    */
    readonly start: number;
    /**
    The block's text content.
    */
    content: string;
    /**
    The block parsers active for this block.
    */
    parsers: LeafBlockParser[];
}
/**
Data structure used during block-level per-line parsing.
*/
declare class Line {
    /**
    The line's full text.
    */
    text: string;
    /**
    The base indent provided by the composite contexts (that have
    been handled so far).
    */
    baseIndent: number;
    /**
    The string position corresponding to the base indent.
    */
    basePos: number;
    /**
    Any markers (i.e. block quote markers) parsed for the contexts.
    A block parser that moves across lines, covering such marks, may
    need to include these in its node structure.
    */
    markers: Element[];
    /**
    The position of the next non-whitespace character beyond any
    list, blockquote, or other composite block markers.
    */
    pos: number;
    /**
    The column of the next non-whitespace character.
    */
    indent: number;
    /**
    The character code of the character after `pos`.
    */
    next: number;
    /**
    Skip whitespace after the given position, return the position of
    the next non-space character or the end of the line if there's
    only space after `from`.
    */
    skipSpace(from: number): number;
    /**
    Move the line's base position forward to the given position.
    This should only be called by composite [block
    parsers](#BlockParser.parse) or [markup skipping
    functions](#NodeSpec.composite).
    */
    moveBase(to: number): void;
    /**
    Move the line's base position forward to the given _column_.
    */
    moveBaseColumn(indent: number): void;
    /**
    Store a composite-block-level marker. Should be called from
    [markup skipping functions](#NodeSpec.composite) when they
    consume any non-whitespace characters.
    */
    addMarker(elt: Element): void;
    /**
    Find the column position at `to`, optionally starting at a given
    position and column.
    */
    countIndent(to: number, from?: number, indent?: number): number;
    /**
    Find the position corresponding to the given column.
    */
    findColumn(goal: number): number;
}
type BlockResult = boolean | null;
/**
Block-level parsing functions get access to this context object.
*/
declare class BlockContext implements PartialParse {
    /**
    The parser configuration used.
    */
    readonly parser: MarkdownParser;
    private line;
    private atEnd;
    private fragments;
    private to;
    stoppedAt: number | null;
    private opaqueBlockDepth;
    /**
    The start of the current line.
    */
    lineStart: number;
    get parsedPos(): number;
    /**
    True while a block parser is consuming source whose interior must not be
    interpreted as container-closing syntax by extension composite blocks.
    Fenced/indented code and raw-TeX blocks use this while advancing across
    their body lines. Container syntax that owns per-line prefixes (lists,
    blockquotes) still runs normally; extensions may opt into this signal.
    */
    get inOpaqueBlock(): boolean;
    advance(): Tree | null;
    stopAt(pos: number): void;
    private reuseFragment;
    /**
    The number of parent blocks surrounding the current block.
    */
    get depth(): number;
    /**
    Get the type of the parent block at the given depth. When no
    depth is passed, return the type of the innermost parent.
    */
    parentType(depth?: number): NodeType;
    /**
    Move to the next input line. This should only be called by
    (non-composite) [block parsers](#BlockParser.parse) that consume
    the line directly, or leaf block parser
    [`nextLine`](#LeafBlockParser.nextLine) methods when they
    consume the current line (and return true).
    */
    nextLine(): boolean;
    /**
    Retrieve the text of the line after the current one, without
    actually moving the context's current line forward.
    */
    peekLine(): string;
    private moveRangeI;
    private lineChunkAt;
    /**
    The end position of the previous line.
    */
    prevLineEnd(): number;
    /**
    Start a composite block. Should only be called from [block
    parser functions](#BlockParser.parse) that return null.
    */
    startComposite(type: string, start: number, value?: number): void;
    /**
    Add a block element. Can be called by [block
    parsers](#BlockParser.parse).
    */
    addElement(elt: Element): void;
    /**
    Add a block element from a [leaf parser](#LeafBlockParser). This
    makes sure any extra composite block markup (such as blockquote
    markers) inside the block are also added to the syntax tree.
    */
    addLeafElement(leaf: LeafBlock, elt: Element): void;
    private finish;
    private addGaps;
    /**
    Create an [`Element`](#Element) object to represent some syntax
    node.
    */
    elt(type: string, from: number, to: number, children?: readonly Element[]): Element;
    elt(tree: Tree, at: number): Element;
}
/**
Used in the [configuration](#MarkdownConfig.defineNodes) to define
new [syntax node
types](https://lezer.codemirror.net/docs/ref/#common.NodeType).
*/
interface NodeSpec {
    /**
    The node's name.
    */
    name: string;
    /**
    Should be set to true if this type represents a block node.
    */
    block?: boolean;
    /**
    If this is a composite block, this should hold a function that,
    at the start of a new line where that block is active, checks
    whether the composite block should continue (return value) and
    optionally [adjusts](#Line.moveBase) the line's base position
    and [registers](#Line.addMarker) nodes for any markers involved
    in the block's syntax.
    */
    composite?(cx: BlockContext, line: Line, value: number): boolean;
    /**
    Add highlighting tag information for this node. The value of
    this property may either by a tag or array of tags to assign
    directly to this node, or an object in the style of
    [`styleTags`](https://lezer.codemirror.net/docs/ref/#highlight.styleTags)'s
    argument to assign more complicated rules.
    */
    style?: Tag | readonly Tag[] | {
        [selector: string]: Tag | readonly Tag[];
    };
}
/**
Inline parsers are called for every character of parts of the
document that are parsed as inline content.
*/
interface InlineParser {
    /**
    This parser's name, which can be used by other parsers to
    [indicate](#InlineParser.before) a relative precedence.
    */
    name: string;
    /**
    The parse function. Gets the next character and its position as
    arguments. Should return -1 if it doesn't handle the character,
    or add some [element](#InlineContext.addElement) or
    [delimiter](#InlineContext.addDelimiter) and return the end
    position of the content it parsed if it can.
    */
    parse(cx: InlineContext, next: number, pos: number): number;
    /**
    When given, this parser will be installed directly before the
    parser with the given name. The default configuration defines
    inline parsers with names Escape, Entity, InlineCode, HTMLTag,
    Emphasis, HardBreak, Link, and Image. When no `before` or
    `after` property is given, the parser is added to the end of the
    list.
    */
    before?: string;
    /**
    When given, the parser will be installed directly _after_ the
    parser with the given name.
    */
    after?: string;
}
/**
Block parsers handle block-level structure. There are three
general types of block parsers:

- Composite block parsers, which handle things like lists and
  blockquotes. These define a [`parse`](#BlockParser.parse) method
  that [starts](#BlockContext.startComposite) a composite block
  and returns null when it recognizes its syntax. The node type
  used by such a block must define a
  [`composite`](#NodeSpec.composite) function as well.

- Eager leaf block parsers, used for things like code or HTML
  blocks. These can unambiguously recognize their content from its
  first line. They define a [`parse`](#BlockParser.parse) method
  that, if it recognizes the construct,
  [moves](#BlockContext.nextLine) the current line forward to the
  line beyond the end of the block,
  [add](#BlockContext.addElement) a syntax node for the block, and
  return true.

- Leaf block parsers that observe a paragraph-like construct as it
  comes in, and optionally decide to handle it at some point. This
  is used for "setext" (underlined) headings and link references.
  These define a [`leaf`](#BlockParser.leaf) method that checks
  the first line of the block and returns a
  [`LeafBlockParser`](#LeafBlockParser) object if it wants to
  observe that block.
*/
interface BlockParser {
    /**
    The name of the parser. Can be used by other block parsers to
    [specify](#BlockParser.before) precedence.
    */
    name: string;
    /**
    The eager parse function, which can look at the block's first
    line and return `false` to do nothing, `true` if it has parsed
    (and [moved past](#BlockContext.nextLine) a block), or `null` if
    it has [started](#BlockContext.startComposite) a composite block.
    */
    parse?(cx: BlockContext, line: Line): BlockResult;
    /**
    A leaf parse function. If no [regular](#BlockParser.parse) parse
    functions match for a given line, its content will be
    accumulated for a paragraph-style block. This method can return
    an [object](#LeafBlockParser) that overrides that style of
    parsing in some situations.
    */
    leaf?(cx: BlockContext, leaf: LeafBlock): LeafBlockParser | null;
    /**
    Some constructs, such as code blocks or newly started
    blockquotes, can interrupt paragraphs even without a blank line.
    If your construct can do this, provide a predicate here that
    recognizes lines that should end a paragraph (or other non-eager
    [leaf block](#BlockParser.leaf)).
    */
    endLeaf?(cx: BlockContext, line: Line, leaf: LeafBlock): boolean;
    /**
    When given, this parser will be installed directly before the
    block parser with the given name. The default configuration
    defines block parsers with names LinkReference, IndentedCode,
    FencedCode, Blockquote, HorizontalRule, BulletList, OrderedList,
    ATXHeading, HTMLBlock, and SetextHeading.
    */
    before?: string;
    /**
    When given, the parser will be installed directly _after_ the
    parser with the given name.
    */
    after?: string;
}
/**
Objects that are used to [override](#BlockParser.leaf)
paragraph-style blocks should conform to this interface.
*/
interface LeafBlockParser {
    /**
    Update the parser's state for the next line, and optionally
    finish the block. This is not called for the first line (the
    object is constructed at that line), but for any further lines.
    When it returns `true`, the block is finished. It is okay for
    the function to [consume](#BlockContext.nextLine) the current
    line or any subsequent lines when returning true.
    */
    nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean;
    /**
    Called when the block is finished by external circumstances
    (such as a blank line or the [start](#BlockParser.endLeaf) of
    another construct). If this parser can handle the block up to
    its current position, it should
    [finish](#BlockContext.addLeafElement) the block and return
    true.
    */
    finish(cx: BlockContext, leaf: LeafBlock): boolean;
}
/**
Objects of this type are used to
[configure](#MarkdownParser.configure) the Markdown parser.
*/
interface MarkdownConfig {
    /**
    Node props to add to the parser's node set.
    */
    props?: readonly NodePropSource[];
    /**
    Define new [node types](#NodeSpec) for use in parser extensions.
    */
    defineNodes?: readonly (string | NodeSpec)[];
    /**
    Define additional [block parsing](#BlockParser) logic.
    */
    parseBlock?: readonly BlockParser[];
    /**
    Define new [inline parsing](#InlineParser) logic.
    */
    parseInline?: readonly InlineParser[];
    /**
    Node names which, when they begin immediately after a completed `[label]`,
    prevent the standard reference-link parser from consuming that following
    bracket as a `LinkLabel`. Pandoc uses this for `normalCite`: `[label]`
    followed by `[@cite]` must leave the citation to the citation parser.
    */
    referenceLabelBlockers?: readonly string[];
    /**
    Preserve Pandoc's email-style blockquote continuation behavior: after a
    marked `>` line, subsequent nonblank unmarked physical lines remain quote
    content until a parser boundary which Pandoc's `endline` actually permits
    to interrupt it. This differs materially from CommonMark block quotes.
    */
    lazyBlockquotes?: boolean;
    /**
    Pandoc's default markdown reader requires a blank line before ATX
    headings, block quotes, and lists, and does not let horizontal rules
    interrupt a paragraph. CommonMark does. Enable Pandoc's `endline` policy
    for those block starts while retaining fenced-code and HTML interruption.
    */
    pandocParagraphContinuation?: boolean;
    /**
    Remove the named parsers from the configuration.
    */
    remove?: readonly string[];
    /**
    Add a parse wrapper (such as a [mixed-language
    parser](#common.parseMixed)) to this parser.
    */
    wrap?: ParseWrapper;
}
/**
To make it possible to group extensions together into bigger
extensions (such as the [Github-flavored Markdown](#GFM)
extension), [reconfiguration](#MarkdownParser.configure) accepts
nested arrays of [config](#MarkdownConfig) objects.
*/
type MarkdownExtension = MarkdownConfig | readonly MarkdownExtension[];
/**
A Markdown parser configuration.
*/
declare class MarkdownParser extends Parser {
    /**
    The parser's syntax [node
    types](https://lezer.codemirror.net/docs/ref/#common.NodeSet).
    */
    readonly nodeSet: NodeSet;
    createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly {
        from: number;
        to: number;
    }[]): PartialParse;
    /**
    Reconfigure the parser.
    */
    configure(spec: MarkdownExtension): MarkdownParser;
    /**
    Parse the given piece of inline text at the given offset,
    returning an array of [`Element`](#Element) objects representing
    the inline content.
    */
    parseInline(text: string, offset: number): Element[];
    /**
    Whether parsing the source beginning at `offset` produces one of the
    configured semantic nodes which Pandoc gives precedence over a reference
    link label at this position.
    */
    referenceLabelBlockedAt(text: string, offset: number): any;
}
/**
Elements are used to compose syntax nodes during parsing.
*/
declare class Element {
    /**
    The node's
    [id](https://lezer.codemirror.net/docs/ref/#common.NodeType.id).
    */
    readonly type: number;
    /**
    The start of the node, as an offset from the start of the document.
    */
    readonly from: number;
    /**
    The end of the node.
    */
    readonly to: number;
}
/**
Delimiters are used during inline parsing to store the positions
of things that _might_ be delimiters, if another matching
delimiter is found. They are identified by objects with these
properties.
*/
interface DelimiterType {
    /**
    If this is given, the delimiter should be matched automatically
    when a piece of inline content is finished. Such delimiters will
    be matched with delimiters of the same type according to their
    [open and close](#InlineContext.addDelimiter) properties. When a
    match is found, the content between the delimiters is wrapped in
    a node whose name is given by the value of this property.

    When this isn't given, you need to match the delimiter eagerly
    using the [`findOpeningDelimiter`](#InlineContext.findOpeningDelimiter)
    and [`takeContent`](#InlineContext.takeContent) methods.
    */
    resolve?: string;
    /**
    If the delimiter itself should, when matched, create a syntax
    node, set this to the name of the syntax node.
    */
    mark?: string;
    /**
    When a standard Markdown link/image successfully consumes a `[` opener at
    the same source range, invalidate this companion delimiter as well. This
    lets extensions that share bracket syntax (notably Pandoc bracketed
    spans) keep their own nesting stack without leaving a stale inner opener
    behind after `[label](target)` becomes a real link.
    */
    consumeWithLink?: boolean;
}
/**
Inline parsing functions get access to this context, and use it to
read the content and emit syntax nodes.
*/
declare class InlineContext {
    /**
    The parser that is being used.
    */
    readonly parser: MarkdownParser;
    /**
    The text of this inline section.
    */
    readonly text: string;
    /**
    The starting offset of the section in the document.
    */
    readonly offset: number;
    /**
    Get the character code at the given (document-relative)
    position.
    */
    char(pos: number): number;
    /**
    The position of the end of this inline section.
    */
    get end(): number;
    /**
    Get a substring of this inline section. Again uses
    document-relative positions.
    */
    slice(from: number, to: number): string;
    /**
    Add a [delimiter](#DelimiterType) at this given position. `open`
    and `close` indicate whether this delimiter is opening, closing,
    or both. Returns the end of the delimiter, for convenient
    returning from [parse functions](#InlineParser.parse).
    */
    addDelimiter(type: DelimiterType, from: number, to: number, open: boolean, close: boolean): number;
    /**
    Returns true when there is an unmatched link or image opening
    token before the current position.
    */
    get hasOpenLink(): boolean;
    /**
    Add an inline element. Returns the end of the element.
    */
    addElement(elt: Element): number;
    /**
    Find an opening delimiter of the given type. Returns `null` if
    no delimiter is found, or an index that can be passed to
    [`takeContent`](#InlineContext.takeContent) otherwise.
    */
    findOpeningDelimiter(type: DelimiterType): number | null;
    /**
    Find the nearest unmatched standard Markdown link opening delimiter.
    Pandoc extensions such as bracketed spans share the same `[` opener as
    links and need to observe which openings the link parser has already
    consumed, rather than maintaining an independent delimiter stack.
    */
    findOpeningLinkDelimiter(): number | null;
    /**
    Remove all inline elements and delimiters starting from the
    given index (which you should get from
    [`findOpeningDelimiter`](#InlineContext.findOpeningDelimiter),
    resolve delimiters inside of them, and return them as an array
    of elements.
    */
    takeContent(startIndex: number): Element[];
    /**
    Return the delimiter at the given index. Mostly useful to get
    additional info out of a delimiter index returned by
    [`findOpeningDelimiter`](#InlineContext.findOpeningDelimiter).
    Returns null if there is no delimiter at this index.
    */
    getDelimiterAt(index: number): {
        from: number;
        to: number;
        type: DelimiterType;
    } | null;
    /**
    Invalidate an unmatched delimiter without discarding the content parsed
    after it. Fork extensions use this when the reference grammar has parsed
    far enough to prove that a speculative opener must backtrack to literal
    source (for example Pandoc `inlineNote` followed by link syntax).
    */
    discardDelimiter(index: number): void;
    /**
    Invalidate extension delimiters that share a source opener with a link
    which has just been recognized. Fork extensions call this too because
    Pandoc's readable-path link parser can recognize a link before the
    default Lezer LinkEnd parser runs.
    */
    discardLinkCompanionDelimiters(from: number, to: number): void;
    /**
    Remove the standard Markdown LinkStart delimiter at an exact source
    opener. Extensions such as Pandoc footnote references initially let the
    Link parser observe `[` as a fallback, but must invalidate that fallback
    once their higher-precedence construct succeeds.
    */
    discardOpeningLinkDelimiter(from: number, to: number): void;
    /**
    Skip space after the given (document) position, returning either
    the position of the next non-space character or the end of the
    section.
    */
    skipSpace(from: number): number;
    /**
    Create an [`Element`](#Element) for a syntax node.
    */
    elt(type: string, from: number, to: number, children?: readonly Element[]): Element;
    elt(tree: Tree, at: number): Element;
    /**
    The opening delimiter type used by the standard link parser.
    */
    static linkStart: DelimiterType;
    /**
    Opening delimiter type used for standard images.
    */
    static imageStart: DelimiterType;
}
/**
The default CommonMark parser.
*/
declare const parser: MarkdownParser;

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `wikilink` (line 1887), with
 * Ext_wikilinks_title_after_pipe / Ext_wikilinks_title_before_pipe.
 */
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Zettelkasten Link Parser
 * CVM-Role:        InlineParser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A small parser that adds Zettelkasten link elements to the tree.
 *
 * END HEADER
 */

interface ZknLinkParserConfig {
    /**
     * Describes whether internal Zettelkasten/Wiki-Links should follow the format
     * `[[link|title]]`, or `[[title|link]]`. If not provided, the parser falls
     * back to the default `[[link|title]]`.
     *
     * * The `[[link|title]]` syntax is used by:
     *   * Obsidian
     *   * Wikipedia (MediaWiki)
     *   * VimWiki
     *   * Orgmode
     * * The `[[title|link]]` syntax is used by:
     *   * GitHub
     */
    format?: 'link|title' | 'title|link';
}

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `attributes`, `attribute`,
 * `identifierAttr`, `classAttr`, `keyValAttr`, and `specialAttr`
 * (starting at line 643 in that revision).
 */
/**
 * Pandoc attribute-list syntax.
 *
 * This mirrors Pandoc's Markdown reader productions `attributes`, `attribute`,
 * `identifierAttr`, `classAttr`, `keyValAttr`, and `specialAttr` rather than
 * trying to approximate them with a brace regex. In particular, whitespace
 * between attributes may cross physical lines, and quoted values may contain
 * escaped quotes, braces, and a non-blank line break.
 */
type PandocAttributeToken = {
    kind: 'id';
    from: number;
    to: number;
    value: string;
} | {
    kind: 'class';
    from: number;
    to: number;
    value: string;
} | {
    kind: 'key-value';
    from: number;
    to: number;
    key: string;
    value: string;
} | {
    kind: 'special';
    from: number;
    to: number;
    value: 'unnumbered';
};
interface PandocAttributeListScan {
    from: number;
    to: number;
    tokens: PandocAttributeToken[];
}
type PandocSyntaxScan<T> = {
    status: 'match';
    value: T;
} | {
    status: 'incomplete';
} | {
    status: 'no-match';
};
/** Parse one braced Pandoc attribute list beginning exactly at `start`. */
declare function scanPandocAttributeList(source: string, start?: number): PandocSyntaxScan<PandocAttributeListScan>;
interface PandocFencedDivOpeningScan {
    markFrom: number;
    markTo: number;
    attribute?: PandocAttributeListScan;
    bareClass?: {
        from: number;
        to: number;
        value: string;
    };
    headerEnd: number;
    headerLineCount: number;
}
declare function scanPandocFencedDivOpening(source: string, final?: boolean): PandocSyntaxScan<PandocFencedDivOpeningScan>;

/**
 * Pandoc citation grammar for the Lezer Markdown fork.
 *
 * Reference implementation: Pandoc 3.10.2, commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs: cite, textualCite, normalCite,
 * citeList, citation, prefix, and suffix (starting at `cite`, line 2230 in
 * that revision). Behavioral acceptance is differential against Pandoc JSON.
 */

type CSL_LOCATOR_TERM = 'article-locator' | 'book' | 'canon' | 'chapter' | 'column' | 'elocation' | 'equation' | 'figure' | 'folio' | 'issue' | 'line' | 'note' | 'opus' | 'page' | 'paragraph' | 'part' | 'rule' | 'section' | 'sub-verbo' | 'supplement' | 'table' | 'timestamp' | 'title-locator' | 'verse' | 'volume';
/**
 * The locatorLabels have been sourced from the CSL locale files. These are the
 * label strings that will trigger the parser to detect an explicit locator
 * label. The programmatic labels are the keys of this Record, and the labels
 * that users can use in various languages are the strings in the corresponding
 * arrays. As of now, only the French, German, and English locator labels have
 * been added to these lists of labels, since these are the three largest
 * communities of Zettlr. Going forward, adding more languages is straight-
 * forward; it just requires some time. But note that citeproc will
 * automatically use the correct language; i.e., using the label "pp." to denote
 * pages will correctly render "S." if using the German language for the output.
 *
 * @var {{ [key: string]: string[] }}}
 */
declare const locatorLabels: Record<CSL_LOCATOR_TERM, string[]>;
/**
 * Record of all valid citation node names.
 */
declare const NODES: {
    /**
     * The containing citation node
     */
    CITATION: string;
    /**
     * Any citation formatting character (brackets, etc.)
     */
    MARK: string;
    /**
     * Citation prefix
     */
    PREFIX: string;
    /**
     * "Suppress author"-flag.
     */
    AUTHORFLAG: string;
    /**
     * The @-sign in front of the citekey
     */
    AT: string;
    /**
     * The citation key.
     */
    KEY: string;
    /**
     * The locator
     */
    LOCATOR: string;
    /**
     * The citation suffix.
     */
    SUFFIX: string;
};
/**
 * Describes a single citation item. Composite citations have only one such item
 * but regular in-text citations can have multiple ones, divided by semicolons.
 */
interface CiteItem {
    /**
     * Citekey -- required.
     */
    id: string;
    /**
     * Locator (only a numerical range)
     */
    locator?: string;
    /**
     * The locator label (what the locator describes). Defaults to "page."
     */
    label?: keyof typeof locatorLabels;
    /**
     * Whether the citekey has the suppress author flag.
     */
    'suppress-author'?: boolean;
    /**
     * Anything before the citekey.
     */
    prefix?: string;
    /**
     * Anything after the citekey or locator.
     */
    suffix?: string;
}
declare function parseCitationLocator(text: string): Pick<CiteItem, 'locator' | 'label'>;
/** Interpret Pandoc's suffix as CSL locator plus the remaining authored affix. */
declare function parseCitationSuffix(suffix: string): Pick<CiteItem, 'locator' | 'label' | 'suffix'>;
/**
 * A full citation cluster.
 */
interface Citation {
    /**
     * Start in the source
     */
    from: number;
    /**
     * End in the source
     */
    to: number;
    /**
     * Raw source string
     */
    source: string;
    /**
     * Whether its composite (@AuthorYear [p. 23]) or not ([@AuthorYear, p. 23]).
     */
    composite: boolean;
    /**
     * All items in this citation. Length === 1 if composite is true.
     */
    items: CiteItem[];
}
declare const citationParser: InlineParser$1;

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/LaTeX.hs `rawLaTeXBlock` (line 153),
 * `rawLaTeXInline` (line 196), `blockCommands`, and `treatAsBlock`;
 * Markdown integration is src/Text/Pandoc/Readers/Markdown.hs
 * `rawLaTeXInline'` (line 2113) under Ext_raw_tex.
 */
interface PandocLatexMathEnvironment {
    environment: string;
    display: boolean;
    end: number;
}
declare function rawLatexEnvironmentAtStart(text: string): string | null;
declare function rawLatexBlockStartsAt(text: string): boolean;
/**
 * Return the offset immediately after the balanced closing environment.
 * `text` must start at the authored `\\begin{...}`. Newlines and arbitrary
 * blank lines are allowed. Same-name nesting is balanced, and TeX comments do
 * not contribute fake open/close tokens.
 */
declare function rawLatexEnvironmentEnd(text: string, environment: string): number | null;
/**
 * Recognize the LaTeX math environments that Pandoc's Markdown reader keeps as
 * RawInline(tex). This is the exact `inlineEnvironments` set from Pandoc
 * 3.10.2 Text/Pandoc/Readers/LaTeX/Math.hs at the pinned reference commit.
 *
 * Pandoc's AST classification and the editor's visual rendering are separate:
 * these remain RawInline(tex) syntax nodes, while callers may render the
 * complete environment as mathematics. `math` is inline; the other admitted
 * environments are display mathematics.
 */
declare function pandocLatexMathEnvironmentAtStart(text: string): PandocLatexMathEnvironment | null;
/**
 * End offset for the subset of Pandoc RawInline(tex) syntax that begins with a
 * control sequence or one of Pandoc's LaTeX inline environments.
 *
 * Reference implementation: Pandoc 3.10.2 `rawLaTeXInline` in
 * Text/Pandoc/Readers/LaTeX.hs (lines 196-207), using `inline` and
 * `inlineEnvironment`. The executable Pandoc JSON reader is the differential
 * oracle for the admitted shapes.
 */
declare function rawLatexInlineEndAtStart(text: string): number | null;
/** Exact end of one editor-supported Pandoc RawBlock(tex) source unit. */
declare function rawLatexBlockEndAtStart(text: string): number | null;
/**
 * End of one Pandoc Markdown `rawTeXBlock`, which may aggregate several
 * adjacent LaTeX blocks.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * Text/Pandoc/Readers/Markdown.hs `rawTeXBlock`:
 * `many1 ((<>) <$> rawLaTeXBlock <*> spnl')`; `spnl'` accepts horizontal
 * whitespace plus at most one newline not followed by another newline.
 * Consequently adjacent raw blocks coalesce, but a blank line separates them.
 */
declare function rawLatexBlockSequenceEndAtStart(text: string): number | null;
interface RawBlockSyntaxNode {
    from: number;
    to: number;
    getChildren: (name: string) => ReadonlyArray<{
        from: number;
        to: number;
    }>;
}
/**
 * Reconstruct the semantic raw-block source from parser-owned content ranges.
 * Container syntax such as `> ` or list indentation lives in the gaps between
 * these ranges and is therefore omitted, matching Pandoc's RawBlock payload.
 */
declare function rawBlockSourceFromNode(node: RawBlockSyntaxNode, read: (from: number, to: number) => string): string;
declare function rawBlockLineRangesFromNode(node: RawBlockSyntaxNode, read: (from: number, to: number) => string): Array<{
    from: number;
    to: number;
}>;

/**
 * Pandoc Markdown extensions owned by this @lezer/markdown fork.
 *
 * The grammar is not specified from Zettlr examples. Every rule in this
 * directory names the Pandoc 3.10.2 implementation it ports, pinned at commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918. Differential tests additionally
 * invoke the real `pandoc` reader as an executable oracle.
 */

interface PandocMarkdownOptions {
    /** Pandoc wikilink extension spelling selected by the application. */
    wikilinks?: ZknLinkParserConfig['format'];
}

/**
Create a Markdown extension to enable nested parsing on code
blocks and/or embedded HTML.
*/
declare function parseCode(config: {
    /**
    When provided, this will be used to parse the content of code
    blocks. `info` is the string after the opening ` ``` ` marker,
    or the empty string if there is no such info or this is an
    indented code block. If there is a parser available for the
    code, it should return a function that can construct the
    [parse](https://lezer.codemirror.net/docs/ref/#common.PartialParse).
    */
    codeParser?: (info: string) => null | Parser;
    /**
    The parser used to parse HTML tags (both block and inline).
    */
    htmlParser?: Parser;
}): MarkdownExtension;

/**
An extension that implements
[GFM-style](https://github.github.com/gfm/#strikethrough-extension-)
Strikethrough syntax using `~~` delimiters.
*/
declare const Strikethrough: MarkdownConfig;
/**
This extension provides
[GFM-style](https://github.github.com/gfm/#tables-extension-)
tables, using syntax like this:

```
| head 1 | head 2 |
| ---    | ---    |
| cell 1 | cell 2 |
```
*/
declare const Table: MarkdownConfig;
/**
Extension providing
[GFM-style](https://github.github.com/gfm/#task-list-items-extension-)
task list items, where list items can be prefixed with `[ ]` or
`[x]` to add a checkbox.
*/
declare const TaskList: MarkdownConfig;
/**
Extension that implements autolinking for
`www.`/`http://`/`https://`/`mailto:`/`xmpp:` URLs and email
addresses.
*/
declare const Autolink: MarkdownConfig;
/**
Extension bundle containing [`Table`](#Table),
[`TaskList`](#TaskList), [`Strikethrough`](#Strikethrough), and
[`Autolink`](#Autolink).
*/
declare const GFM: MarkdownConfig[];
/**
Extension providing
[Pandoc-style](https://pandoc.org/MANUAL.html#superscripts-and-subscripts)
superscript using `^` markers.
*/
declare const Superscript: MarkdownConfig;
/**
Extension providing
[Pandoc-style](https://pandoc.org/MANUAL.html#superscripts-and-subscripts)
subscript using `~` markers.
*/
declare const Subscript: MarkdownConfig;
/**
Extension that parses two colons with only letters, underscores,
and numbers between them as `Emoji` nodes.
*/
declare const Emoji: MarkdownConfig;

/**
 * Complete Pandoc-flavored Markdown extension supported by this fork.
 * The reused Lezer extensions correspond to Pandoc's default superscript,
 * subscript, and task-list extensions. Strikeout is fork-owned because GFM's
 * delimiter-run behavior is not Pandoc's `strikeout` parser.
 */
declare function Pandoc(options?: PandocMarkdownOptions): MarkdownExtension;
declare function createPandocParser(options?: PandocMarkdownOptions): MarkdownParser;

export { Autolink, BlockContext, BlockParser, NODES as CITATION_NODES, CSL_LOCATOR_TERM, Citation, CiteItem, DelimiterType, Element, Emoji, GFM, InlineContext, InlineParser, LeafBlock, LeafBlockParser, Line, MarkdownConfig, MarkdownExtension, MarkdownParser, NodeSpec, Pandoc, PandocAttributeListScan, PandocAttributeToken, PandocFencedDivOpeningScan, PandocLatexMathEnvironment, PandocMarkdownOptions, PandocSyntaxScan, RawBlockSyntaxNode, Strikethrough, Subscript, Superscript, Table, TaskList, ZknLinkParserConfig, citationParser, createPandocParser, pandocLatexMathEnvironmentAtStart, parseCitationLocator, parseCitationSuffix, parseCode, parser, rawBlockLineRangesFromNode, rawBlockSourceFromNode, rawLatexBlockEndAtStart, rawLatexBlockSequenceEndAtStart, rawLatexBlockStartsAt, rawLatexEnvironmentAtStart, rawLatexEnvironmentEnd, rawLatexInlineEndAtStart, scanPandocAttributeList, scanPandocFencedDivOpening };
