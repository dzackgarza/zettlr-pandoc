'use strict';

var common = require('@lezer/common');
var highlight = require('@lezer/highlight');
var entities = require('entities');

class CompositeBlock {
    static create(type, value, from, parentHash, end) {
        let hash = (parentHash + (parentHash << 8) + type + (value << 4)) | 0;
        return new CompositeBlock(type, value, from, hash, end, [], []);
    }
    constructor(type,
    // Used for indentation in list items, markup character in lists
    value, from, hash, end, children, positions) {
        this.type = type;
        this.value = value;
        this.from = from;
        this.hash = hash;
        this.end = end;
        this.children = children;
        this.positions = positions;
        this.hashProp = [[common.NodeProp.contextHash, hash]];
    }
    addChild(child, pos) {
        if (child.prop(common.NodeProp.contextHash) != this.hash)
            child = new common.Tree(child.type, child.children, child.positions, child.length, this.hashProp);
        this.children.push(child);
        this.positions.push(pos);
    }
    toTree(nodeSet, end = this.end) {
        let last = this.children.length - 1;
        if (last >= 0)
            end = Math.max(end, this.positions[last] + this.children[last].length + this.from);
        return new common.Tree(nodeSet.types[this.type], this.children, this.positions, end - this.from).balance({
            makeTree: (children, positions, length) => new common.Tree(common.NodeType.none, children, positions, length, this.hashProp)
        });
    }
}
var Type;
(function (Type) {
    Type[Type["Document"] = 1] = "Document";
    Type[Type["CodeBlock"] = 2] = "CodeBlock";
    Type[Type["FencedCode"] = 3] = "FencedCode";
    Type[Type["Blockquote"] = 4] = "Blockquote";
    Type[Type["HorizontalRule"] = 5] = "HorizontalRule";
    Type[Type["BulletList"] = 6] = "BulletList";
    Type[Type["OrderedList"] = 7] = "OrderedList";
    Type[Type["ListItem"] = 8] = "ListItem";
    Type[Type["ATXHeading1"] = 9] = "ATXHeading1";
    Type[Type["ATXHeading2"] = 10] = "ATXHeading2";
    Type[Type["ATXHeading3"] = 11] = "ATXHeading3";
    Type[Type["ATXHeading4"] = 12] = "ATXHeading4";
    Type[Type["ATXHeading5"] = 13] = "ATXHeading5";
    Type[Type["ATXHeading6"] = 14] = "ATXHeading6";
    Type[Type["SetextHeading1"] = 15] = "SetextHeading1";
    Type[Type["SetextHeading2"] = 16] = "SetextHeading2";
    Type[Type["HTMLBlock"] = 17] = "HTMLBlock";
    Type[Type["LinkReference"] = 18] = "LinkReference";
    Type[Type["Paragraph"] = 19] = "Paragraph";
    Type[Type["CommentBlock"] = 20] = "CommentBlock";
    Type[Type["ProcessingInstructionBlock"] = 21] = "ProcessingInstructionBlock";
    // Inline
    Type[Type["Escape"] = 22] = "Escape";
    Type[Type["Entity"] = 23] = "Entity";
    Type[Type["HardBreak"] = 24] = "HardBreak";
    Type[Type["Emphasis"] = 25] = "Emphasis";
    Type[Type["StrongEmphasis"] = 26] = "StrongEmphasis";
    Type[Type["Link"] = 27] = "Link";
    Type[Type["Image"] = 28] = "Image";
    Type[Type["InlineCode"] = 29] = "InlineCode";
    Type[Type["HTMLTag"] = 30] = "HTMLTag";
    Type[Type["Comment"] = 31] = "Comment";
    Type[Type["ProcessingInstruction"] = 32] = "ProcessingInstruction";
    Type[Type["Autolink"] = 33] = "Autolink";
    // Smaller tokens
    Type[Type["HeaderMark"] = 34] = "HeaderMark";
    Type[Type["QuoteMark"] = 35] = "QuoteMark";
    Type[Type["ListMark"] = 36] = "ListMark";
    Type[Type["LinkMark"] = 37] = "LinkMark";
    Type[Type["EmphasisMark"] = 38] = "EmphasisMark";
    Type[Type["CodeMark"] = 39] = "CodeMark";
    Type[Type["CodeText"] = 40] = "CodeText";
    Type[Type["CodeInfo"] = 41] = "CodeInfo";
    Type[Type["LinkTitle"] = 42] = "LinkTitle";
    Type[Type["LinkLabel"] = 43] = "LinkLabel";
    Type[Type["URL"] = 44] = "URL";
})(Type || (Type = {}));
/**
Data structure used to accumulate a block's content during [leaf
block parsing](#BlockParser.leaf).
*/
class LeafBlock {
    /**
    @internal
    */
    constructor(
    /**
    The start position of the block.
    */
    start,
    /**
    The block's text content.
    */
    content) {
        this.start = start;
        this.content = content;
        /**
        @internal
        */
        this.marks = [];
        /**
        The block parsers active for this block.
        */
        this.parsers = [];
    }
}
/**
Data structure used during block-level per-line parsing.
*/
class Line {
    constructor() {
        /**
        The line's full text.
        */
        this.text = "";
        /**
        The base indent provided by the composite contexts (that have
        been handled so far).
        */
        this.baseIndent = 0;
        /**
        The string position corresponding to the base indent.
        */
        this.basePos = 0;
        /**
        The number of contexts handled @internal
        */
        this.depth = 0;
        /**
        Any markers (i.e. block quote markers) parsed for the contexts.
        A block parser that moves across lines, covering such marks, may
        need to include these in its node structure.
        */
        this.markers = [];
        /**
        The position of the next non-whitespace character beyond any
        list, blockquote, or other composite block markers.
        */
        this.pos = 0;
        /**
        The column of the next non-whitespace character.
        */
        this.indent = 0;
        /**
        The character code of the character after `pos`.
        */
        this.next = -1;
    }
    /**
    @internal
    */
    forward() {
        if (this.basePos > this.pos)
            this.forwardInner();
    }
    /**
    @internal
    */
    forwardInner() {
        let newPos = this.skipSpace(this.basePos);
        this.indent = this.countIndent(newPos, this.pos, this.indent);
        this.pos = newPos;
        this.next = newPos == this.text.length ? -1 : this.text.charCodeAt(newPos);
    }
    /**
    Skip whitespace after the given position, return the position of
    the next non-space character or the end of the line if there's
    only space after `from`.
    */
    skipSpace(from) { return skipSpace(this.text, from); }
    /**
    @internal
    */
    reset(text) {
        this.text = text;
        this.baseIndent = this.basePos = this.pos = this.indent = 0;
        this.forwardInner();
        this.depth = 1;
        while (this.markers.length)
            this.markers.pop();
    }
    /**
    Move the line's base position forward to the given position.
    This should only be called by composite [block
    parsers](#BlockParser.parse) or [markup skipping
    functions](#NodeSpec.composite).
    */
    moveBase(to) {
        this.basePos = to;
        this.baseIndent = this.countIndent(to, this.pos, this.indent);
    }
    /**
    Move the line's base position forward to the given _column_.
    */
    moveBaseColumn(indent) {
        this.baseIndent = indent;
        this.basePos = this.findColumn(indent);
    }
    /**
    Store a composite-block-level marker. Should be called from
    [markup skipping functions](#NodeSpec.composite) when they
    consume any non-whitespace characters.
    */
    addMarker(elt) {
        this.markers.push(elt);
    }
    /**
    Find the column position at `to`, optionally starting at a given
    position and column.
    */
    countIndent(to, from = 0, indent = 0) {
        for (let i = from; i < to; i++)
            indent += this.text.charCodeAt(i) == 9 ? 4 - indent % 4 : 1;
        return indent;
    }
    /**
    Find the position corresponding to the given column.
    */
    findColumn(goal) {
        let i = 0;
        for (let indent = 0; i < this.text.length && indent < goal; i++)
            indent += this.text.charCodeAt(i) == 9 ? 4 - indent % 4 : 1;
        return i;
    }
    /**
    @internal
    */
    scrub() {
        if (!this.baseIndent)
            return this.text;
        let result = "";
        for (let i = 0; i < this.basePos; i++)
            result += " ";
        return result + this.text.slice(this.basePos);
    }
}
function skipForList(bl, cx, line) {
    if (line.pos == line.text.length ||
        (bl != cx.block && line.indent >= cx.stack[line.depth + 1].value + line.baseIndent))
        return true;
    if (line.indent >= line.baseIndent + 4)
        return false;
    let size = (bl.type == Type.OrderedList ? isOrderedList : isBulletList)(line, cx, false);
    return size > 0 &&
        (bl.type != Type.BulletList || isHorizontalRule(line, cx, false) < 0) &&
        line.text.charCodeAt(line.pos + size - 1) == bl.value;
}
const DefaultSkipMarkup = {
    [Type.Blockquote](bl, cx, line) {
        if (line.next != 62 /* '>' */)
            return false;
        line.markers.push(elt(Type.QuoteMark, cx.lineStart + line.pos, cx.lineStart + line.pos + 1));
        line.moveBase(line.pos + (space(line.text.charCodeAt(line.pos + 1)) ? 2 : 1));
        bl.end = cx.lineStart + line.text.length;
        return true;
    },
    [Type.ListItem](bl, _cx, line) {
        if (line.indent < line.baseIndent + bl.value && line.next > -1)
            return false;
        line.moveBaseColumn(line.baseIndent + bl.value);
        return true;
    },
    [Type.OrderedList]: skipForList,
    [Type.BulletList]: skipForList,
    [Type.Document]() { return true; }
};
function space(ch) { return ch == 32 || ch == 9 || ch == 10 || ch == 13; }
function skipSpace(line, i = 0) {
    while (i < line.length && space(line.charCodeAt(i)))
        i++;
    return i;
}
function skipSpaceBack(line, i, to) {
    while (i > to && space(line.charCodeAt(i - 1)))
        i--;
    return i;
}
function isFencedCode(line) {
    if (line.next != 96 && line.next != 126 /* '`~' */)
        return -1;
    let pos = line.pos + 1;
    while (pos < line.text.length && line.text.charCodeAt(pos) == line.next)
        pos++;
    if (pos < line.pos + 3)
        return -1;
    if (line.next == 96)
        for (let i = pos; i < line.text.length; i++)
            if (line.text.charCodeAt(i) == 96)
                return -1;
    return pos;
}
function isBlockquote(line) {
    return line.next != 62 /* '>' */ ? -1 : line.text.charCodeAt(line.pos + 1) == 32 ? 2 : 1;
}
function isHorizontalRule(line, cx, breaking) {
    if (line.next != 42 && line.next != 45 && line.next != 95 /* '_-*' */)
        return -1;
    let count = 1;
    for (let pos = line.pos + 1; pos < line.text.length; pos++) {
        let ch = line.text.charCodeAt(pos);
        if (ch == line.next)
            count++;
        else if (!space(ch))
            return -1;
    }
    // Setext headers take precedence
    if (breaking && line.next == 45 && isSetextUnderline(line) > -1 && line.depth == cx.stack.length &&
        cx.parser.leafBlockParsers.indexOf(DefaultLeafBlocks.SetextHeading) > -1)
        return -1;
    return count < 3 ? -1 : 1;
}
function inList(cx, type) {
    for (let i = cx.stack.length - 1; i >= 0; i--)
        if (cx.stack[i].type == type)
            return true;
    return false;
}
function isBulletList(line, cx, breaking) {
    return (line.next == 45 || line.next == 43 || line.next == 42 /* '-+*' */) &&
        (line.pos == line.text.length - 1 || space(line.text.charCodeAt(line.pos + 1))) &&
        (!breaking || inList(cx, Type.BulletList) || line.skipSpace(line.pos + 2) < line.text.length) ? 1 : -1;
}
function isOrderedList(line, cx, breaking) {
    let pos = line.pos, next = line.next;
    for (;;) {
        if (next >= 48 && next <= 57 /* '0-9' */)
            pos++;
        else
            break;
        if (pos == line.text.length)
            return -1;
        next = line.text.charCodeAt(pos);
    }
    if (pos == line.pos || pos > line.pos + 9 ||
        (next != 46 && next != 41 /* '.)' */) ||
        (pos < line.text.length - 1 && !space(line.text.charCodeAt(pos + 1))) ||
        breaking && !inList(cx, Type.OrderedList) &&
            (line.skipSpace(pos + 1) == line.text.length || pos > line.pos + 1 || line.next != 49 /* '1' */))
        return -1;
    return pos + 1 - line.pos;
}
function isAtxHeading(line) {
    if (line.next != 35 /* '#' */)
        return -1;
    let pos = line.pos + 1;
    while (pos < line.text.length && line.text.charCodeAt(pos) == 35)
        pos++;
    if (pos < line.text.length && line.text.charCodeAt(pos) != 32)
        return -1;
    let size = pos - line.pos;
    return size > 6 ? -1 : size;
}
function isSetextUnderline(line) {
    if (line.next != 45 && line.next != 61 /* '-=' */ || line.indent >= line.baseIndent + 4)
        return -1;
    let pos = line.pos + 1;
    while (pos < line.text.length && line.text.charCodeAt(pos) == line.next)
        pos++;
    let end = pos;
    while (pos < line.text.length && space(line.text.charCodeAt(pos)))
        pos++;
    return pos == line.text.length ? end : -1;
}
const EmptyLine = /^[ \t]*$/, CommentEnd = /-->/, ProcessingEnd = /\?>/;
const HTMLBlockStyle = [
    [/^<(?:script|pre|style)(?:\s|>|$)/i, /<\/(?:script|pre|style)>/i],
    [/^\s*<!--/, CommentEnd],
    [/^\s*<\?/, ProcessingEnd],
    [/^\s*<![A-Z]/, />/],
    [/^\s*<!\[CDATA\[/, /\]\]>/],
    [/^\s*<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i, EmptyLine],
    [/^\s*(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][\w-.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i, EmptyLine]
];
function isHTMLBlock(line, _cx, breaking) {
    if (line.next != 60 /* '<' */)
        return -1;
    let rest = line.text.slice(line.pos);
    for (let i = 0, e = HTMLBlockStyle.length - (breaking ? 1 : 0); i < e; i++)
        if (HTMLBlockStyle[i][0].test(rest))
            return i;
    return -1;
}
function getListIndent(line, pos) {
    let indentAfter = line.countIndent(pos, line.pos, line.indent);
    let skipped = line.skipSpace(pos);
    let indented = line.countIndent(skipped, pos, indentAfter);
    return indented >= indentAfter + 5 || skipped == line.text.length ? indentAfter + 1 : indented;
}
function addCodeText(marks, from, to) {
    let last = marks.length - 1;
    if (last >= 0 && marks[last].to == from && marks[last].type == Type.CodeText)
        marks[last].to = to;
    else
        marks.push(elt(Type.CodeText, from, to));
}
// Rules for parsing blocks. A return value of false means the rule
// doesn't apply here, true means it does. When true is returned and
// `p.line` has been updated, the rule is assumed to have consumed a
// leaf block. Otherwise, it is assumed to have opened a context.
const DefaultBlockParsers = {
    LinkReference: undefined,
    IndentedCode(cx, line) {
        let base = line.baseIndent + 4;
        if (line.indent < base)
            return false;
        let start = line.findColumn(base);
        let from = cx.lineStart + start, to = cx.lineStart + line.text.length;
        let marks = [], pendingMarks = [];
        addCodeText(marks, from, to);
        while (cx.nextLine() && line.depth >= cx.stack.length) {
            if (line.pos == line.text.length) { // Empty
                addCodeText(pendingMarks, cx.lineStart - 1, cx.lineStart);
                for (let m of line.markers)
                    pendingMarks.push(m);
            }
            else if (line.indent < base) {
                break;
            }
            else {
                if (pendingMarks.length) {
                    for (let m of pendingMarks) {
                        if (m.type == Type.CodeText)
                            addCodeText(marks, m.from, m.to);
                        else
                            marks.push(m);
                    }
                    pendingMarks = [];
                }
                addCodeText(marks, cx.lineStart - 1, cx.lineStart);
                for (let m of line.markers)
                    marks.push(m);
                to = cx.lineStart + line.text.length;
                let codeStart = cx.lineStart + line.findColumn(line.baseIndent + 4);
                if (codeStart < to)
                    addCodeText(marks, codeStart, to);
            }
        }
        if (pendingMarks.length) {
            pendingMarks = pendingMarks.filter(m => m.type != Type.CodeText);
            if (pendingMarks.length)
                line.markers = pendingMarks.concat(line.markers);
        }
        cx.addNode(cx.buffer.writeElements(marks, -from).finish(Type.CodeBlock, to - from), from);
        return true;
    },
    FencedCode(cx, line) {
        let fenceEnd = isFencedCode(line);
        if (fenceEnd < 0)
            return false;
        let from = cx.lineStart + line.pos, ch = line.next, len = fenceEnd - line.pos;
        let infoFrom = line.skipSpace(fenceEnd), infoTo = skipSpaceBack(line.text, line.text.length, infoFrom);
        let marks = [elt(Type.CodeMark, from, from + len)];
        if (infoFrom < infoTo)
            marks.push(elt(Type.CodeInfo, cx.lineStart + infoFrom, cx.lineStart + infoTo));
        for (let first = true, empty = true, hasLine = false; cx.nextLine() && line.depth >= cx.stack.length; first = false) {
            let i = line.pos;
            if (line.indent - line.baseIndent < 4)
                while (i < line.text.length && line.text.charCodeAt(i) == ch)
                    i++;
            if (i - line.pos >= len && line.skipSpace(i) == line.text.length) {
                for (let m of line.markers)
                    marks.push(m);
                if (empty && hasLine)
                    addCodeText(marks, cx.lineStart - 1, cx.lineStart);
                marks.push(elt(Type.CodeMark, cx.lineStart + line.pos, cx.lineStart + i));
                cx.nextLine();
                break;
            }
            else {
                hasLine = true;
                if (!first) {
                    addCodeText(marks, cx.lineStart - 1, cx.lineStart);
                    empty = false;
                }
                for (let m of line.markers)
                    marks.push(m);
                let textStart = cx.lineStart + line.basePos, textEnd = cx.lineStart + line.text.length;
                if (textStart < textEnd) {
                    addCodeText(marks, textStart, textEnd);
                    empty = false;
                }
            }
        }
        cx.addNode(cx.buffer.writeElements(marks, -from)
            .finish(Type.FencedCode, cx.prevLineEnd() - from), from);
        return true;
    },
    Blockquote(cx, line) {
        let size = isBlockquote(line);
        if (size < 0)
            return false;
        cx.startContext(Type.Blockquote, line.pos);
        cx.addNode(Type.QuoteMark, cx.lineStart + line.pos, cx.lineStart + line.pos + 1);
        line.moveBase(line.pos + size);
        return null;
    },
    HorizontalRule(cx, line) {
        if (isHorizontalRule(line, cx, false) < 0)
            return false;
        let from = cx.lineStart + line.pos;
        cx.nextLine();
        cx.addNode(Type.HorizontalRule, from);
        return true;
    },
    BulletList(cx, line) {
        let size = isBulletList(line, cx, false);
        if (size < 0)
            return false;
        if (cx.block.type != Type.BulletList)
            cx.startContext(Type.BulletList, line.basePos, line.next);
        let newBase = getListIndent(line, line.pos + 1);
        cx.startContext(Type.ListItem, line.basePos, newBase - line.baseIndent);
        cx.addNode(Type.ListMark, cx.lineStart + line.pos, cx.lineStart + line.pos + size);
        line.moveBaseColumn(newBase);
        return null;
    },
    OrderedList(cx, line) {
        let size = isOrderedList(line, cx, false);
        if (size < 0)
            return false;
        if (cx.block.type != Type.OrderedList)
            cx.startContext(Type.OrderedList, line.basePos, line.text.charCodeAt(line.pos + size - 1));
        let newBase = getListIndent(line, line.pos + size);
        cx.startContext(Type.ListItem, line.basePos, newBase - line.baseIndent);
        cx.addNode(Type.ListMark, cx.lineStart + line.pos, cx.lineStart + line.pos + size);
        line.moveBaseColumn(newBase);
        return null;
    },
    ATXHeading(cx, line) {
        let size = isAtxHeading(line);
        if (size < 0)
            return false;
        let off = line.pos, from = cx.lineStart + off;
        let endOfSpace = skipSpaceBack(line.text, line.text.length, off), after = endOfSpace;
        while (after > off && line.text.charCodeAt(after - 1) == line.next)
            after--;
        if (after == endOfSpace || after == off || !space(line.text.charCodeAt(after - 1)))
            after = line.text.length;
        let buf = cx.buffer
            .write(Type.HeaderMark, 0, size)
            .writeElements(cx.parser.parseInline(line.text.slice(off + size + 1, after), from + size + 1), -from);
        if (after < line.text.length)
            buf.write(Type.HeaderMark, after - off, endOfSpace - off);
        let node = buf.finish(Type.ATXHeading1 - 1 + size, line.text.length - off);
        cx.nextLine();
        cx.addNode(node, from);
        return true;
    },
    HTMLBlock(cx, line) {
        let type = isHTMLBlock(line, cx, false);
        if (type < 0)
            return false;
        let from = cx.lineStart + line.pos, end = HTMLBlockStyle[type][1];
        let marks = [], trailing = end != EmptyLine;
        while (!end.test(line.text) && cx.nextLine()) {
            if (line.depth < cx.stack.length) {
                trailing = false;
                break;
            }
            for (let m of line.markers)
                marks.push(m);
        }
        if (trailing)
            cx.nextLine();
        let nodeType = end == CommentEnd ? Type.CommentBlock : end == ProcessingEnd ? Type.ProcessingInstructionBlock : Type.HTMLBlock;
        let to = cx.prevLineEnd();
        cx.addNode(cx.buffer.writeElements(marks, -from).finish(nodeType, to - from), from);
        return true;
    },
    SetextHeading: undefined // Specifies relative precedence for block-continue function
};
// This implements a state machine that incrementally parses link references. At each
// next line, it looks ahead to see if the line continues the reference or not. If it
// doesn't and a valid link is available ending before that line, it finishes that.
// Similarly, on `finish` (when the leaf is terminated by external circumstances), it
// creates a link reference if there's a valid reference up to the current point.
class LinkReferenceParser {
    constructor(leaf) {
        this.stage = 0 /* RefStage.Start */;
        this.elts = [];
        this.pos = 0;
        this.start = leaf.start;
        this.advance(leaf.content);
    }
    nextLine(cx, line, leaf) {
        if (this.stage == -1 /* RefStage.Failed */)
            return false;
        let content = leaf.content + "\n" + line.scrub();
        let finish = this.advance(content);
        if (finish > -1 && finish < content.length)
            return this.complete(cx, leaf, finish);
        return false;
    }
    finish(cx, leaf) {
        if ((this.stage == 2 /* RefStage.Link */ || this.stage == 3 /* RefStage.Title */) && skipSpace(leaf.content, this.pos) == leaf.content.length)
            return this.complete(cx, leaf, leaf.content.length);
        return false;
    }
    complete(cx, leaf, len) {
        cx.addLeafElement(leaf, elt(Type.LinkReference, this.start, this.start + len, this.elts));
        return true;
    }
    nextStage(elt) {
        if (elt) {
            this.pos = elt.to - this.start;
            this.elts.push(elt);
            this.stage++;
            return true;
        }
        if (elt === false)
            this.stage = -1 /* RefStage.Failed */;
        return false;
    }
    advance(content) {
        for (;;) {
            if (this.stage == -1 /* RefStage.Failed */) {
                return -1;
            }
            else if (this.stage == 0 /* RefStage.Start */) {
                if (!this.nextStage(parseLinkLabel(content, this.pos, this.start, true)))
                    return -1;
                if (content.charCodeAt(this.pos) != 58 /* ':' */)
                    return this.stage = -1 /* RefStage.Failed */;
                this.elts.push(elt(Type.LinkMark, this.pos + this.start, this.pos + this.start + 1));
                this.pos++;
            }
            else if (this.stage == 1 /* RefStage.Label */) {
                if (!this.nextStage(parseURL(content, skipSpace(content, this.pos), this.start)))
                    return -1;
            }
            else if (this.stage == 2 /* RefStage.Link */) {
                let skip = skipSpace(content, this.pos), end = 0;
                if (skip > this.pos) {
                    let title = parseLinkTitle(content, skip, this.start);
                    if (title) {
                        let titleEnd = lineEnd$1(content, title.to - this.start);
                        if (titleEnd > 0) {
                            this.nextStage(title);
                            end = titleEnd;
                        }
                    }
                }
                if (!end)
                    end = lineEnd$1(content, this.pos);
                return end > 0 && end < content.length ? end : -1;
            }
            else { // RefStage.Title
                return lineEnd$1(content, this.pos);
            }
        }
    }
}
function lineEnd$1(text, pos) {
    for (; pos < text.length; pos++) {
        let next = text.charCodeAt(pos);
        if (next == 10)
            break;
        if (!space(next))
            return -1;
    }
    return pos;
}
class SetextHeadingParser {
    nextLine(cx, line, leaf) {
        let underline = line.depth < cx.stack.length ? -1 : isSetextUnderline(line);
        let next = line.next;
        if (underline < 0)
            return false;
        let underlineMark = elt(Type.HeaderMark, cx.lineStart + line.pos, cx.lineStart + underline);
        cx.nextLine();
        cx.addLeafElement(leaf, elt(next == 61 ? Type.SetextHeading1 : Type.SetextHeading2, leaf.start, cx.prevLineEnd(), [
            ...cx.parser.parseInline(leaf.content, leaf.start),
            underlineMark
        ]));
        return true;
    }
    finish() {
        return false;
    }
}
const DefaultLeafBlocks = {
    LinkReference(_, leaf) { return leaf.content.charCodeAt(0) == 91 /* '[' */ ? new LinkReferenceParser(leaf) : null; },
    SetextHeading() { return new SetextHeadingParser; }
};
const DefaultEndLeaf = [
    (_, line) => isAtxHeading(line) >= 0,
    (_, line) => isFencedCode(line) >= 0,
    (_, line) => isBlockquote(line) >= 0,
    (p, line) => isBulletList(line, p, true) >= 0,
    (p, line) => isOrderedList(line, p, true) >= 0,
    (p, line) => isHorizontalRule(line, p, true) >= 0,
    (p, line) => isHTMLBlock(line, p, true) >= 0
];
const scanLineResult = { text: "", end: 0 };
/**
Block-level parsing functions get access to this context object.
*/
class BlockContext {
    /**
    @internal
    */
    constructor(
    /**
    The parser configuration used.
    */
    parser,
    /**
    @internal
    */
    input, fragments,
    /**
    @internal
    */
    ranges) {
        this.parser = parser;
        this.input = input;
        this.ranges = ranges;
        this.line = new Line();
        this.atEnd = false;
        /**
        For reused nodes on gaps, we can't directly put the original
        node into the tree, since that may be bigger than its parent.
        When this happens, we create a dummy tree that is replaced by
        the proper node in `injectGaps` @internal
        */
        this.reusePlaceholders = new Map;
        this.stoppedAt = null;
        /**
        The range index that absoluteLineStart points into @internal
        */
        this.rangeI = 0;
        this.to = ranges[ranges.length - 1].to;
        this.lineStart = this.absoluteLineStart = this.absoluteLineEnd = ranges[0].from;
        this.block = CompositeBlock.create(Type.Document, 0, this.lineStart, 0, 0);
        this.stack = [this.block];
        this.fragments = fragments.length ? new FragmentCursor(fragments, input) : null;
        this.readLine();
    }
    get parsedPos() {
        return this.absoluteLineStart;
    }
    advance() {
        if (this.stoppedAt != null && this.absoluteLineStart > this.stoppedAt)
            return this.finish();
        let { line } = this;
        for (;;) {
            for (let markI = 0;;) {
                let next = line.depth < this.stack.length ? this.stack[this.stack.length - 1] : null;
                while (markI < line.markers.length && (!next || line.markers[markI].from < next.end)) {
                    let mark = line.markers[markI++];
                    this.addNode(mark.type, mark.from, mark.to);
                }
                if (!next)
                    break;
                this.finishContext();
            }
            if (line.pos < line.text.length)
                break;
            // Empty line
            if (!this.nextLine())
                return this.finish();
        }
        if (this.fragments && this.reuseFragment(line.basePos))
            return null;
        start: for (;;) {
            for (let type of this.parser.blockParsers)
                if (type) {
                    let result = type(this, line);
                    if (result != false) {
                        if (result == true)
                            return null;
                        line.forward();
                        continue start;
                    }
                }
            break;
        }
        if (line.pos == line.text.length)
            return this.nextLine() ? null : this.finish();
        let leaf = new LeafBlock(this.lineStart + line.pos, line.text.slice(line.pos));
        for (let parse of this.parser.leafBlockParsers)
            if (parse) {
                let parser = parse(this, leaf);
                if (parser)
                    leaf.parsers.push(parser);
            }
        lines: while (this.nextLine()) {
            if (line.pos == line.text.length)
                break;
            if (line.indent < line.baseIndent + 4) {
                for (let stop of this.parser.endLeafBlock)
                    if (stop(this, line, leaf))
                        break lines;
            }
            for (let parser of leaf.parsers)
                if (parser.nextLine(this, line, leaf))
                    return null;
            leaf.content += "\n" + line.scrub();
            for (let m of line.markers)
                leaf.marks.push(m);
        }
        this.finishLeaf(leaf);
        return null;
    }
    stopAt(pos) {
        if (this.stoppedAt != null && this.stoppedAt < pos)
            throw new RangeError("Can't move stoppedAt forward");
        this.stoppedAt = pos;
    }
    reuseFragment(start) {
        if (!this.fragments.moveTo(this.absoluteLineStart + start, this.absoluteLineStart) ||
            !this.fragments.matches(this.block.hash))
            return false;
        let taken = this.fragments.takeNodes(this);
        if (!taken)
            return false;
        this.absoluteLineStart += taken;
        this.lineStart = toRelative(this.absoluteLineStart, this.ranges);
        this.moveRangeI();
        if (this.absoluteLineStart < this.to) {
            this.lineStart++;
            this.absoluteLineStart++;
            this.readLine();
        }
        else {
            this.atEnd = true;
            this.readLine();
        }
        return true;
    }
    /**
    The number of parent blocks surrounding the current block.
    */
    get depth() {
        return this.stack.length;
    }
    /**
    Get the type of the parent block at the given depth. When no
    depth is passed, return the type of the innermost parent.
    */
    parentType(depth = this.depth - 1) {
        return this.parser.nodeSet.types[this.stack[depth].type];
    }
    /**
    Move to the next input line. This should only be called by
    (non-composite) [block parsers](#BlockParser.parse) that consume
    the line directly, or leaf block parser
    [`nextLine`](#LeafBlockParser.nextLine) methods when they
    consume the current line (and return true).
    */
    nextLine() {
        this.lineStart += this.line.text.length;
        if (this.absoluteLineEnd >= this.to) {
            this.absoluteLineStart = this.absoluteLineEnd;
            this.atEnd = true;
            this.readLine();
            return false;
        }
        else {
            this.lineStart++;
            this.absoluteLineStart = this.absoluteLineEnd + 1;
            this.moveRangeI();
            this.readLine();
            return true;
        }
    }
    /**
    Retrieve the text of the line after the current one, without
    actually moving the context's current line forward.
    */
    peekLine() {
        return this.scanLine(this.absoluteLineEnd + 1).text;
    }
    moveRangeI() {
        while (this.rangeI < this.ranges.length - 1 && this.absoluteLineStart >= this.ranges[this.rangeI].to) {
            this.rangeI++;
            this.absoluteLineStart = Math.max(this.absoluteLineStart, this.ranges[this.rangeI].from);
        }
    }
    /**
    @internal
    Collect the text for the next line.
    */
    scanLine(start) {
        let r = scanLineResult;
        r.end = start;
        if (start >= this.to) {
            r.text = "";
        }
        else {
            r.text = this.lineChunkAt(start);
            r.end += r.text.length;
            if (this.ranges.length > 1) {
                let textOffset = this.absoluteLineStart, rangeI = this.rangeI;
                while (this.ranges[rangeI].to < r.end) {
                    rangeI++;
                    let nextFrom = this.ranges[rangeI].from;
                    let after = this.lineChunkAt(nextFrom);
                    r.end = nextFrom + after.length;
                    r.text = r.text.slice(0, this.ranges[rangeI - 1].to - textOffset) + after;
                    textOffset = r.end - r.text.length;
                }
            }
        }
        return r;
    }
    /**
    @internal
    Populate this.line with the content of the next line. Skip
    leading characters covered by composite blocks.
    */
    readLine() {
        let { line } = this, { text, end } = this.scanLine(this.absoluteLineStart);
        this.absoluteLineEnd = end;
        line.reset(text);
        for (; line.depth < this.stack.length; line.depth++) {
            let cx = this.stack[line.depth], handler = this.parser.skipContextMarkup[cx.type];
            if (!handler)
                throw new Error("Unhandled block context " + Type[cx.type]);
            let marks = this.line.markers.length;
            if (!handler(cx, this, line)) {
                if (this.line.markers.length > marks)
                    cx.end = this.line.markers[this.line.markers.length - 1].to;
                line.forward();
                break;
            }
            line.forward();
        }
    }
    lineChunkAt(pos) {
        let next = this.input.chunk(pos), text;
        if (!this.input.lineChunks) {
            let eol = next.indexOf("\n");
            text = eol < 0 ? next : next.slice(0, eol);
        }
        else {
            text = next == "\n" ? "" : next;
        }
        return pos + text.length > this.to ? text.slice(0, this.to - pos) : text;
    }
    /**
    The end position of the previous line.
    */
    prevLineEnd() { return this.atEnd ? this.lineStart : this.lineStart - 1; }
    /**
    @internal
    */
    startContext(type, start, value = 0) {
        this.block = CompositeBlock.create(type, value, this.lineStart + start, this.block.hash, this.lineStart + this.line.text.length);
        this.stack.push(this.block);
    }
    /**
    Start a composite block. Should only be called from [block
    parser functions](#BlockParser.parse) that return null.
    */
    startComposite(type, start, value = 0) {
        this.startContext(this.parser.getNodeType(type), start, value);
    }
    /**
    @internal
    */
    addNode(block, from, to) {
        if (typeof block == "number")
            block = new common.Tree(this.parser.nodeSet.types[block], none, none, (to !== null && to !== void 0 ? to : this.prevLineEnd()) - from);
        this.block.addChild(block, from - this.block.from);
    }
    /**
    Add a block element. Can be called by [block
    parsers](#BlockParser.parse).
    */
    addElement(elt) {
        this.block.addChild(elt.toTree(this.parser.nodeSet), elt.from - this.block.from);
    }
    /**
    Add a block element from a [leaf parser](#LeafBlockParser). This
    makes sure any extra composite block markup (such as blockquote
    markers) inside the block are also added to the syntax tree.
    */
    addLeafElement(leaf, elt) {
        this.addNode(this.buffer
            .writeElements(injectMarks(elt.children, leaf.marks), -elt.from)
            .finish(elt.type, elt.to - elt.from), elt.from);
    }
    /**
    @internal
    */
    finishContext() {
        let cx = this.stack.pop();
        let top = this.stack[this.stack.length - 1];
        top.addChild(cx.toTree(this.parser.nodeSet), cx.from - top.from);
        this.block = top;
    }
    finish() {
        while (this.stack.length > 1)
            this.finishContext();
        return this.addGaps(this.block.toTree(this.parser.nodeSet, this.lineStart));
    }
    addGaps(tree) {
        return this.ranges.length > 1 ?
            injectGaps(this.ranges, 0, tree.topNode, this.ranges[0].from, this.reusePlaceholders) : tree;
    }
    /**
    @internal
    */
    finishLeaf(leaf) {
        for (let parser of leaf.parsers)
            if (parser.finish(this, leaf))
                return;
        let inline = injectMarks(this.parser.parseInline(leaf.content, leaf.start), leaf.marks);
        this.addNode(this.buffer
            .writeElements(inline, -leaf.start)
            .finish(Type.Paragraph, leaf.content.length), leaf.start);
    }
    elt(type, from, to, children) {
        if (typeof type == "string")
            return elt(this.parser.getNodeType(type), from, to, children);
        return new TreeElement(type, from);
    }
    /**
    @internal
    */
    get buffer() { return new Buffer(this.parser.nodeSet); }
}
function injectGaps(ranges, rangeI, tree, offset, dummies) {
    let rangeEnd = ranges[rangeI].to;
    let children = [], positions = [], start = tree.from + offset;
    function movePastNext(upto, inclusive) {
        while (inclusive ? upto >= rangeEnd : upto > rangeEnd) {
            let size = ranges[rangeI + 1].from - rangeEnd;
            offset += size;
            upto += size;
            rangeI++;
            rangeEnd = ranges[rangeI].to;
        }
    }
    for (let ch = tree.firstChild; ch; ch = ch.nextSibling) {
        movePastNext(ch.from + offset, true);
        let from = ch.from + offset, node, reuse = dummies.get(ch.tree);
        if (reuse) {
            node = reuse;
        }
        else if (ch.to + offset > rangeEnd) {
            node = injectGaps(ranges, rangeI, ch, offset, dummies);
            movePastNext(ch.to + offset, false);
        }
        else {
            node = ch.toTree();
        }
        children.push(node);
        positions.push(from - start);
    }
    movePastNext(tree.to + offset, false);
    return new common.Tree(tree.type, children, positions, tree.to + offset - start, tree.tree ? tree.tree.propValues : undefined);
}
/**
A Markdown parser configuration.
*/
class MarkdownParser extends common.Parser {
    /**
    @internal
    */
    constructor(
    /**
    The parser's syntax [node
    types](https://lezer.codemirror.net/docs/ref/#common.NodeSet).
    */
    nodeSet,
    /**
    @internal
    */
    blockParsers,
    /**
    @internal
    */
    leafBlockParsers,
    /**
    @internal
    */
    blockNames,
    /**
    @internal
    */
    endLeafBlock,
    /**
    @internal
    */
    skipContextMarkup,
    /**
    @internal
    */
    inlineParsers,
    /**
    @internal
    */
    inlineNames,
    /**
    @internal
    */
    wrappers) {
        super();
        this.nodeSet = nodeSet;
        this.blockParsers = blockParsers;
        this.leafBlockParsers = leafBlockParsers;
        this.blockNames = blockNames;
        this.endLeafBlock = endLeafBlock;
        this.skipContextMarkup = skipContextMarkup;
        this.inlineParsers = inlineParsers;
        this.inlineNames = inlineNames;
        this.wrappers = wrappers;
        /**
        @internal
        */
        this.nodeTypes = Object.create(null);
        for (let t of nodeSet.types)
            this.nodeTypes[t.name] = t.id;
    }
    createParse(input, fragments, ranges) {
        let parse = new BlockContext(this, input, fragments, ranges);
        for (let w of this.wrappers)
            parse = w(parse, input, fragments, ranges);
        return parse;
    }
    /**
    Reconfigure the parser.
    */
    configure(spec) {
        let config = resolveConfig(spec);
        if (!config)
            return this;
        let { nodeSet, skipContextMarkup } = this;
        let blockParsers = this.blockParsers.slice(), leafBlockParsers = this.leafBlockParsers.slice(), blockNames = this.blockNames.slice(), inlineParsers = this.inlineParsers.slice(), inlineNames = this.inlineNames.slice(), endLeafBlock = this.endLeafBlock.slice(), wrappers = this.wrappers;
        if (nonEmpty(config.defineNodes)) {
            skipContextMarkup = Object.assign({}, skipContextMarkup);
            let nodeTypes = nodeSet.types.slice(), styles;
            for (let s of config.defineNodes) {
                let { name, block, composite, style } = typeof s == "string" ? { name: s } : s;
                if (nodeTypes.some(t => t.name == name))
                    continue;
                if (composite)
                    skipContextMarkup[nodeTypes.length] =
                        (bl, cx, line) => composite(cx, line, bl.value);
                let id = nodeTypes.length;
                let group = composite ? ["Block", "BlockContext"] : !block ? undefined
                    : id >= Type.ATXHeading1 && id <= Type.SetextHeading2 ? ["Block", "LeafBlock", "Heading"] : ["Block", "LeafBlock"];
                nodeTypes.push(common.NodeType.define({
                    id,
                    name,
                    props: group && [[common.NodeProp.group, group]]
                }));
                if (style) {
                    if (!styles)
                        styles = {};
                    if (Array.isArray(style) || style instanceof highlight.Tag)
                        styles[name] = style;
                    else
                        Object.assign(styles, style);
                }
            }
            nodeSet = new common.NodeSet(nodeTypes);
            if (styles)
                nodeSet = nodeSet.extend(highlight.styleTags(styles));
        }
        if (nonEmpty(config.props))
            nodeSet = nodeSet.extend(...config.props);
        if (nonEmpty(config.remove)) {
            for (let rm of config.remove) {
                let block = this.blockNames.indexOf(rm), inline = this.inlineNames.indexOf(rm);
                if (block > -1)
                    blockParsers[block] = leafBlockParsers[block] = undefined;
                if (inline > -1)
                    inlineParsers[inline] = undefined;
            }
        }
        if (nonEmpty(config.parseBlock)) {
            for (let spec of config.parseBlock) {
                let found = blockNames.indexOf(spec.name);
                if (found > -1) {
                    blockParsers[found] = spec.parse;
                    leafBlockParsers[found] = spec.leaf;
                }
                else {
                    let pos = spec.before ? findName(blockNames, spec.before)
                        : spec.after ? findName(blockNames, spec.after) + 1 : blockNames.length - 1;
                    blockParsers.splice(pos, 0, spec.parse);
                    leafBlockParsers.splice(pos, 0, spec.leaf);
                    blockNames.splice(pos, 0, spec.name);
                }
                if (spec.endLeaf)
                    endLeafBlock.push(spec.endLeaf);
            }
        }
        if (nonEmpty(config.parseInline)) {
            for (let spec of config.parseInline) {
                let found = inlineNames.indexOf(spec.name);
                if (found > -1) {
                    inlineParsers[found] = spec.parse;
                }
                else {
                    let pos = spec.before ? findName(inlineNames, spec.before)
                        : spec.after ? findName(inlineNames, spec.after) + 1 : inlineNames.length - 1;
                    inlineParsers.splice(pos, 0, spec.parse);
                    inlineNames.splice(pos, 0, spec.name);
                }
            }
        }
        if (config.wrap)
            wrappers = wrappers.concat(config.wrap);
        return new MarkdownParser(nodeSet, blockParsers, leafBlockParsers, blockNames, endLeafBlock, skipContextMarkup, inlineParsers, inlineNames, wrappers);
    }
    /**
    @internal
    */
    getNodeType(name) {
        let found = this.nodeTypes[name];
        if (found == null)
            throw new RangeError(`Unknown node type '${name}'`);
        return found;
    }
    /**
    Parse the given piece of inline text at the given offset,
    returning an array of [`Element`](#Element) objects representing
    the inline content.
    */
    parseInline(text, offset) {
        let cx = new InlineContext(this, text, offset);
        outer: for (let pos = offset; pos < cx.end;) {
            let next = cx.char(pos);
            for (let token of this.inlineParsers)
                if (token) {
                    let result = token(cx, next, pos);
                    if (result >= 0) {
                        pos = result;
                        continue outer;
                    }
                }
            pos++;
        }
        return cx.resolveMarkers(0);
    }
}
function nonEmpty(a) {
    return a != null && a.length > 0;
}
function resolveConfig(spec) {
    if (!Array.isArray(spec))
        return spec;
    if (spec.length == 0)
        return null;
    let conf = resolveConfig(spec[0]);
    if (spec.length == 1)
        return conf;
    let rest = resolveConfig(spec.slice(1));
    if (!rest || !conf)
        return conf || rest;
    let conc = (a, b) => (a || none).concat(b || none);
    let wrapA = conf.wrap, wrapB = rest.wrap;
    return {
        props: conc(conf.props, rest.props),
        defineNodes: conc(conf.defineNodes, rest.defineNodes),
        parseBlock: conc(conf.parseBlock, rest.parseBlock),
        parseInline: conc(conf.parseInline, rest.parseInline),
        remove: conc(conf.remove, rest.remove),
        wrap: !wrapA ? wrapB : !wrapB ? wrapA :
            (inner, input, fragments, ranges) => wrapA(wrapB(inner, input, fragments, ranges), input, fragments, ranges)
    };
}
function findName(names, name) {
    let found = names.indexOf(name);
    if (found < 0)
        throw new RangeError(`Position specified relative to unknown parser ${name}`);
    return found;
}
let nodeTypes = [common.NodeType.none];
for (let i = 1, name; name = Type[i]; i++) {
    nodeTypes[i] = common.NodeType.define({
        id: i,
        name,
        props: i >= Type.Escape ? [] : [[common.NodeProp.group, i in DefaultSkipMarkup ? ["Block", "BlockContext"] : ["Block", "LeafBlock"]]],
        top: name == "Document"
    });
}
const none = [];
class Buffer {
    constructor(nodeSet) {
        this.nodeSet = nodeSet;
        this.content = [];
        this.nodes = [];
    }
    write(type, from, to, children = 0) {
        this.content.push(type, from, to, 4 + children * 4);
        return this;
    }
    writeElements(elts, offset = 0) {
        for (let e of elts)
            e.writeTo(this, offset);
        return this;
    }
    finish(type, length) {
        return common.Tree.build({
            buffer: this.content,
            nodeSet: this.nodeSet,
            reused: this.nodes,
            topID: type,
            length
        });
    }
}
/**
Elements are used to compose syntax nodes during parsing.
*/
class Element {
    /**
    @internal
    */
    constructor(
    /**
    The node's
    [id](https://lezer.codemirror.net/docs/ref/#common.NodeType.id).
    */
    type,
    /**
    The start of the node, as an offset from the start of the document.
    */
    from,
    /**
    The end of the node.
    */
    to,
    /**
    The node's child nodes @internal
    */
    children = none) {
        this.type = type;
        this.from = from;
        this.to = to;
        this.children = children;
    }
    /**
    @internal
    */
    writeTo(buf, offset) {
        let startOff = buf.content.length;
        buf.writeElements(this.children, offset);
        buf.content.push(this.type, this.from + offset, this.to + offset, buf.content.length + 4 - startOff);
    }
    /**
    @internal
    */
    toTree(nodeSet) {
        return new Buffer(nodeSet).writeElements(this.children, -this.from).finish(this.type, this.to - this.from);
    }
}
class TreeElement {
    constructor(tree, from) {
        this.tree = tree;
        this.from = from;
    }
    get to() { return this.from + this.tree.length; }
    get type() { return this.tree.type.id; }
    get children() { return none; }
    writeTo(buf, offset) {
        buf.nodes.push(this.tree);
        buf.content.push(buf.nodes.length - 1, this.from + offset, this.to + offset, -1);
    }
    toTree() { return this.tree; }
}
function elt(type, from, to, children) {
    return new Element(type, from, to, children);
}
const EmphasisUnderscore = { resolve: "Emphasis", mark: "EmphasisMark" };
const EmphasisAsterisk = { resolve: "Emphasis", mark: "EmphasisMark" };
const LinkStart = {}, ImageStart = {};
class InlineDelimiter {
    constructor(type, from, to, side) {
        this.type = type;
        this.from = from;
        this.to = to;
        this.side = side;
    }
}
const Escapable = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
let Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027]/;
try {
    Punctuation = new RegExp("[\\p{S}|\\p{P}]", "u");
}
catch (_) { }
const DefaultInline = {
    Escape(cx, next, start) {
        if (next != 92 /* '\\' */ || start == cx.end - 1)
            return -1;
        let escaped = cx.char(start + 1);
        for (let i = 0; i < Escapable.length; i++)
            if (Escapable.charCodeAt(i) == escaped)
                return cx.append(elt(Type.Escape, start, start + 2));
        return -1;
    },
    Entity(cx, next, start) {
        if (next != 38 /* '&' */)
            return -1;
        let m = /^(?:#\d+|#x[a-f\d]+|\w+);/i.exec(cx.slice(start + 1, start + 31));
        return m ? cx.append(elt(Type.Entity, start, start + 1 + m[0].length)) : -1;
    },
    InlineCode(cx, next, start) {
        if (next != 96 /* '`' */ || start && cx.char(start - 1) == 96)
            return -1;
        let pos = start + 1;
        while (pos < cx.end && cx.char(pos) == 96)
            pos++;
        let size = pos - start, curSize = 0;
        for (; pos < cx.end; pos++) {
            if (cx.char(pos) == 96) {
                curSize++;
                if (curSize == size && cx.char(pos + 1) != 96)
                    return cx.append(elt(Type.InlineCode, start, pos + 1, [
                        elt(Type.CodeMark, start, start + size),
                        elt(Type.CodeMark, pos + 1 - size, pos + 1)
                    ]));
            }
            else {
                curSize = 0;
            }
        }
        return -1;
    },
    HTMLTag(cx, next, start) {
        if (next != 60 /* '<' */ || start == cx.end - 1)
            return -1;
        let after = cx.slice(start + 1, cx.end);
        let url = /^(?:[a-z][-\w+.]+:[^\s>]+|[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*)>/i.exec(after);
        if (url) {
            return cx.append(elt(Type.Autolink, start, start + 1 + url[0].length, [
                elt(Type.LinkMark, start, start + 1),
                // url[0] includes the closing bracket, so exclude it from this slice
                elt(Type.URL, start + 1, start + url[0].length),
                elt(Type.LinkMark, start + url[0].length, start + 1 + url[0].length)
            ]));
        }
        let comment = /^!--[^>](?:-[^-]|[^-])*?-->/i.exec(after);
        if (comment)
            return cx.append(elt(Type.Comment, start, start + 1 + comment[0].length));
        let procInst = /^\?[^]*?\?>/.exec(after);
        if (procInst)
            return cx.append(elt(Type.ProcessingInstruction, start, start + 1 + procInst[0].length));
        let m = /^(?:![A-Z][^]*?>|!\[CDATA\[[^]*?\]\]>|\/\s*[a-zA-Z][\w-]*\s*>|\s*[a-zA-Z][\w-]*(\s+[a-zA-Z:_][\w-.:]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*(\/\s*)?>)/.exec(after);
        if (!m)
            return -1;
        return cx.append(elt(Type.HTMLTag, start, start + 1 + m[0].length));
    },
    Emphasis(cx, next, start) {
        if (next != 95 && next != 42)
            return -1;
        let pos = start + 1;
        while (cx.char(pos) == next)
            pos++;
        let before = cx.slice(start - 1, start), after = cx.slice(pos, pos + 1);
        let pBefore = Punctuation.test(before), pAfter = Punctuation.test(after);
        let sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
        let leftFlanking = !sAfter && (!pAfter || sBefore || pBefore);
        let rightFlanking = !sBefore && (!pBefore || sAfter || pAfter);
        let canOpen = leftFlanking && (next == 42 || !rightFlanking || pBefore);
        let canClose = rightFlanking && (next == 42 || !leftFlanking || pAfter);
        return cx.append(new InlineDelimiter(next == 95 ? EmphasisUnderscore : EmphasisAsterisk, start, pos, (canOpen ? 1 /* Mark.Open */ : 0 /* Mark.None */) | (canClose ? 2 /* Mark.Close */ : 0 /* Mark.None */)));
    },
    HardBreak(cx, next, start) {
        if (next == 92 /* '\\' */ && cx.char(start + 1) == 10 /* '\n' */)
            return cx.append(elt(Type.HardBreak, start, start + 2));
        if (next == 32) {
            let pos = start + 1;
            while (cx.char(pos) == 32)
                pos++;
            if (cx.char(pos) == 10 && pos >= start + 2)
                return cx.append(elt(Type.HardBreak, start, pos + 1));
        }
        return -1;
    },
    Link(cx, next, start) {
        return next == 91 /* '[' */ ? cx.append(new InlineDelimiter(LinkStart, start, start + 1, 1 /* Mark.Open */)) : -1;
    },
    Image(cx, next, start) {
        return next == 33 /* '!' */ && cx.char(start + 1) == 91 /* '[' */
            ? cx.append(new InlineDelimiter(ImageStart, start, start + 2, 1 /* Mark.Open */)) : -1;
    },
    LinkEnd(cx, next, start) {
        if (next != 93 /* ']' */)
            return -1;
        // Scanning back to the next link/image start marker
        for (let i = cx.parts.length - 1; i >= 0; i--) {
            let part = cx.parts[i];
            if (part instanceof InlineDelimiter && (part.type == LinkStart || part.type == ImageStart)) {
                // If this one has been set invalid (because it would produce
                // a nested link) or there's no valid link here ignore both.
                if (!part.side || cx.skipSpace(part.to) == start && !/[(\[]/.test(cx.slice(start + 1, start + 2))) {
                    cx.parts[i] = null;
                    return -1;
                }
                // Finish the content and replace the entire range in
                // this.parts with the link/image node.
                let content = cx.takeContent(i);
                let link = cx.parts[i] = finishLink(cx, content, part.type == LinkStart ? Type.Link : Type.Image, part.from, start + 1);
                // Set any open-link markers before this link to invalid.
                if (part.type == LinkStart)
                    for (let j = 0; j < i; j++) {
                        let p = cx.parts[j];
                        if (p instanceof InlineDelimiter && p.type == LinkStart)
                            p.side = 0 /* Mark.None */;
                    }
                return link.to;
            }
        }
        return -1;
    }
};
function finishLink(cx, content, type, start, startPos) {
    let { text } = cx, next = cx.char(startPos), endPos = startPos;
    content.unshift(elt(Type.LinkMark, start, start + (type == Type.Image ? 2 : 1)));
    content.push(elt(Type.LinkMark, startPos - 1, startPos));
    if (next == 40 /* '(' */) {
        let pos = cx.skipSpace(startPos + 1);
        let dest = parseURL(text, pos - cx.offset, cx.offset), title;
        if (dest) {
            pos = cx.skipSpace(dest.to);
            // The destination and title must be separated by whitespace
            if (pos != dest.to) {
                title = parseLinkTitle(text, pos - cx.offset, cx.offset);
                if (title)
                    pos = cx.skipSpace(title.to);
            }
        }
        if (cx.char(pos) == 41 /* ')' */) {
            content.push(elt(Type.LinkMark, startPos, startPos + 1));
            endPos = pos + 1;
            if (dest)
                content.push(dest);
            if (title)
                content.push(title);
            content.push(elt(Type.LinkMark, pos, endPos));
        }
    }
    else if (next == 91 /* '[' */) {
        let label = parseLinkLabel(text, startPos - cx.offset, cx.offset, false);
        if (label) {
            content.push(label);
            endPos = label.to;
        }
    }
    return elt(type, start, endPos, content);
}
// These return `null` when falling off the end of the input, `false`
// when parsing fails otherwise (for use in the incremental link
// reference parser).
function parseURL(text, start, offset) {
    let next = text.charCodeAt(start);
    if (next == 60 /* '<' */) {
        for (let pos = start + 1; pos < text.length; pos++) {
            let ch = text.charCodeAt(pos);
            if (ch == 62 /* '>' */)
                return elt(Type.URL, start + offset, pos + 1 + offset);
            if (ch == 60 || ch == 10 /* '<\n' */)
                return false;
        }
        return null;
    }
    else {
        let depth = 0, pos = start;
        for (let escaped = false; pos < text.length; pos++) {
            let ch = text.charCodeAt(pos);
            if (space(ch)) {
                break;
            }
            else if (escaped) {
                escaped = false;
            }
            else if (ch == 40 /* '(' */) {
                depth++;
            }
            else if (ch == 41 /* ')' */) {
                if (!depth)
                    break;
                depth--;
            }
            else if (ch == 92 /* '\\' */) {
                escaped = true;
            }
        }
        return pos > start ? elt(Type.URL, start + offset, pos + offset) : pos == text.length ? null : false;
    }
}
function parseLinkTitle(text, start, offset) {
    let next = text.charCodeAt(start);
    if (next != 39 && next != 34 && next != 40 /* '"\'(' */)
        return false;
    let end = next == 40 ? 41 : next;
    for (let pos = start + 1, escaped = false; pos < text.length; pos++) {
        let ch = text.charCodeAt(pos);
        if (escaped)
            escaped = false;
        else if (ch == end)
            return elt(Type.LinkTitle, start + offset, pos + 1 + offset);
        else if (ch == 92 /* '\\' */)
            escaped = true;
    }
    return null;
}
function parseLinkLabel(text, start, offset, requireNonWS) {
    for (let escaped = false, pos = start + 1, end = Math.min(text.length, pos + 999); pos < end; pos++) {
        let ch = text.charCodeAt(pos);
        if (escaped)
            escaped = false;
        else if (ch == 93 /* ']' */)
            return requireNonWS ? false : elt(Type.LinkLabel, start + offset, pos + 1 + offset);
        else {
            if (requireNonWS && !space(ch))
                requireNonWS = false;
            if (ch == 91 /* '[' */)
                return false;
            else if (ch == 92 /* '\\' */)
                escaped = true;
        }
    }
    return null;
}
/**
Inline parsing functions get access to this context, and use it to
read the content and emit syntax nodes.
*/
class InlineContext {
    /**
    @internal
    */
    constructor(
    /**
    The parser that is being used.
    */
    parser,
    /**
    The text of this inline section.
    */
    text,
    /**
    The starting offset of the section in the document.
    */
    offset) {
        this.parser = parser;
        this.text = text;
        this.offset = offset;
        /**
        @internal
        */
        this.parts = [];
    }
    /**
    Get the character code at the given (document-relative)
    position.
    */
    char(pos) { return pos >= this.end ? -1 : this.text.charCodeAt(pos - this.offset); }
    /**
    The position of the end of this inline section.
    */
    get end() { return this.offset + this.text.length; }
    /**
    Get a substring of this inline section. Again uses
    document-relative positions.
    */
    slice(from, to) { return this.text.slice(from - this.offset, to - this.offset); }
    /**
    @internal
    */
    append(elt) {
        this.parts.push(elt);
        return elt.to;
    }
    /**
    Add a [delimiter](#DelimiterType) at this given position. `open`
    and `close` indicate whether this delimiter is opening, closing,
    or both. Returns the end of the delimiter, for convenient
    returning from [parse functions](#InlineParser.parse).
    */
    addDelimiter(type, from, to, open, close) {
        return this.append(new InlineDelimiter(type, from, to, (open ? 1 /* Mark.Open */ : 0 /* Mark.None */) | (close ? 2 /* Mark.Close */ : 0 /* Mark.None */)));
    }
    /**
    Returns true when there is an unmatched link or image opening
    token before the current position.
    */
    get hasOpenLink() {
        for (let i = this.parts.length - 1; i >= 0; i--) {
            let part = this.parts[i];
            if (part instanceof InlineDelimiter && (part.type == LinkStart || part.type == ImageStart))
                return true;
        }
        return false;
    }
    /**
    Add an inline element. Returns the end of the element.
    */
    addElement(elt) {
        return this.append(elt);
    }
    /**
    Resolve markers between this.parts.length and from, wrapping matched markers in the
    appropriate node and updating the content of this.parts. @internal
    */
    resolveMarkers(from) {
        // Scan forward, looking for closing tokens
        for (let i = from; i < this.parts.length; i++) {
            let close = this.parts[i];
            if (!(close instanceof InlineDelimiter && close.type.resolve && (close.side & 2 /* Mark.Close */)))
                continue;
            let emp = close.type == EmphasisUnderscore || close.type == EmphasisAsterisk;
            let closeSize = close.to - close.from;
            let open, j = i - 1;
            // Continue scanning for a matching opening token
            for (; j >= from; j--) {
                let part = this.parts[j];
                if (part instanceof InlineDelimiter && (part.side & 1 /* Mark.Open */) && part.type == close.type &&
                    // Ignore emphasis delimiters where the character count doesn't match
                    !(emp && ((close.side & 1 /* Mark.Open */) || (part.side & 2 /* Mark.Close */)) &&
                        (part.to - part.from + closeSize) % 3 == 0 && ((part.to - part.from) % 3 || closeSize % 3))) {
                    open = part;
                    break;
                }
            }
            if (!open)
                continue;
            let type = close.type.resolve, content = [];
            let start = open.from, end = close.to;
            // Emphasis marker effect depends on the character count. Size consumed is minimum of the two
            // markers.
            if (emp) {
                let size = Math.min(2, open.to - open.from, closeSize);
                start = open.to - size;
                end = close.from + size;
                type = size == 1 ? "Emphasis" : "StrongEmphasis";
            }
            // Move the covered region into content, optionally adding marker nodes
            if (open.type.mark)
                content.push(this.elt(open.type.mark, start, open.to));
            for (let k = j + 1; k < i; k++) {
                if (this.parts[k] instanceof Element)
                    content.push(this.parts[k]);
                this.parts[k] = null;
            }
            if (close.type.mark)
                content.push(this.elt(close.type.mark, close.from, end));
            let element = this.elt(type, start, end, content);
            // If there are leftover emphasis marker characters, shrink the close/open markers. Otherwise, clear them.
            this.parts[j] = emp && open.from != start ? new InlineDelimiter(open.type, open.from, start, open.side) : null;
            let keep = this.parts[i] = emp && close.to != end ? new InlineDelimiter(close.type, end, close.to, close.side) : null;
            // Insert the new element in this.parts
            if (keep)
                this.parts.splice(i, 0, element);
            else
                this.parts[i] = element;
        }
        // Collect the elements remaining in this.parts into an array.
        let result = [];
        for (let i = from; i < this.parts.length; i++) {
            let part = this.parts[i];
            if (part instanceof Element)
                result.push(part);
        }
        return result;
    }
    /**
    Find an opening delimiter of the given type. Returns `null` if
    no delimiter is found, or an index that can be passed to
    [`takeContent`](#InlineContext.takeContent) otherwise.
    */
    findOpeningDelimiter(type) {
        for (let i = this.parts.length - 1; i >= 0; i--) {
            let part = this.parts[i];
            if (part instanceof InlineDelimiter && part.type == type && (part.side & 1 /* Mark.Open */))
                return i;
        }
        return null;
    }
    /**
    Remove all inline elements and delimiters starting from the
    given index (which you should get from
    [`findOpeningDelimiter`](#InlineContext.findOpeningDelimiter),
    resolve delimiters inside of them, and return them as an array
    of elements.
    */
    takeContent(startIndex) {
        let content = this.resolveMarkers(startIndex);
        this.parts.length = startIndex;
        return content;
    }
    /**
    Return the delimiter at the given index. Mostly useful to get
    additional info out of a delimiter index returned by
    [`findOpeningDelimiter`](#InlineContext.findOpeningDelimiter).
    Returns null if there is no delimiter at this index.
    */
    getDelimiterAt(index) {
        let part = this.parts[index];
        return part instanceof InlineDelimiter ? part : null;
    }
    /**
    Skip space after the given (document) position, returning either
    the position of the next non-space character or the end of the
    section.
    */
    skipSpace(from) { return skipSpace(this.text, from - this.offset) + this.offset; }
    elt(type, from, to, children) {
        if (typeof type == "string")
            return elt(this.parser.getNodeType(type), from, to, children);
        return new TreeElement(type, from);
    }
}
/**
The opening delimiter type used by the standard link parser.
*/
InlineContext.linkStart = LinkStart;
/**
Opening delimiter type used for standard images.
*/
InlineContext.imageStart = ImageStart;
function injectMarks(elements, marks) {
    if (!marks.length)
        return elements;
    if (!elements.length)
        return marks;
    let elts = elements.slice(), eI = 0;
    for (let mark of marks) {
        while (eI < elts.length && elts[eI].to < mark.to)
            eI++;
        if (eI < elts.length && elts[eI].from < mark.from) {
            let e = elts[eI];
            if (e instanceof Element)
                elts[eI] = new Element(e.type, e.from, e.to, injectMarks(e.children, [mark]));
        }
        else {
            elts.splice(eI++, 0, mark);
        }
    }
    return elts;
}
// These are blocks that can span blank lines, and should thus only be
// reused if their next sibling is also being reused.
const NotLast = [Type.CodeBlock, Type.ListItem, Type.OrderedList, Type.BulletList];
class FragmentCursor {
    constructor(fragments, input) {
        this.fragments = fragments;
        this.input = input;
        // Index into fragment array
        this.i = 0;
        // Active fragment
        this.fragment = null;
        this.fragmentEnd = -1;
        // Cursor into the current fragment, if any. When `moveTo` returns
        // true, this points at the first block after `pos`.
        this.cursor = null;
        if (fragments.length)
            this.fragment = fragments[this.i++];
    }
    nextFragment() {
        this.fragment = this.i < this.fragments.length ? this.fragments[this.i++] : null;
        this.cursor = null;
        this.fragmentEnd = -1;
    }
    moveTo(pos, lineStart) {
        while (this.fragment && this.fragment.to <= pos)
            this.nextFragment();
        if (!this.fragment || this.fragment.from > (pos ? pos - 1 : 0))
            return false;
        if (this.fragmentEnd < 0) {
            let end = this.fragment.to;
            while (end > 0 && this.input.read(end - 1, end) != "\n")
                end--;
            this.fragmentEnd = end ? end - 1 : 0;
        }
        let c = this.cursor;
        if (!c) {
            c = this.cursor = this.fragment.tree.cursor();
            c.firstChild();
        }
        let rPos = pos + this.fragment.offset;
        while (c.to <= rPos)
            if (!c.parent())
                return false;
        for (;;) {
            if (c.from >= rPos)
                return this.fragment.from <= lineStart;
            if (!c.childAfter(rPos))
                return false;
        }
    }
    matches(hash) {
        let tree = this.cursor.tree;
        return tree && tree.prop(common.NodeProp.contextHash) == hash;
    }
    takeNodes(cx) {
        let cur = this.cursor, off = this.fragment.offset, fragEnd = this.fragmentEnd - (this.fragment.openEnd ? 1 : 0);
        let start = cx.absoluteLineStart, end = start, blockI = cx.block.children.length;
        let prevEnd = end, prevI = blockI;
        for (;;) {
            if (cur.to - off > fragEnd) {
                if (cur.type.isAnonymous && cur.firstChild())
                    continue;
                break;
            }
            let pos = toRelative(cur.from - off, cx.ranges);
            if (cur.to - off <= cx.ranges[cx.rangeI].to) { // Fits in current range
                cx.addNode(cur.tree, pos);
            }
            else {
                let dummy = new common.Tree(cx.parser.nodeSet.types[Type.Paragraph], [], [], 0, cx.block.hashProp);
                cx.reusePlaceholders.set(dummy, cur.tree);
                cx.addNode(dummy, pos);
            }
            // Taken content must always end in a block, because incremental
            // parsing happens on block boundaries. Never stop directly
            // after an indented code block, since those can continue after
            // any number of blank lines.
            if (cur.type.is("Block")) {
                if (NotLast.indexOf(cur.type.id) < 0) {
                    end = cur.to - off;
                    blockI = cx.block.children.length;
                }
                else {
                    end = prevEnd;
                    blockI = prevI;
                }
                prevEnd = cur.to - off;
                prevI = cx.block.children.length;
            }
            if (!cur.nextSibling())
                break;
        }
        while (cx.block.children.length > blockI) {
            cx.block.children.pop();
            cx.block.positions.pop();
        }
        return end - start;
    }
}
// Convert an input-stream-relative position to a
// Markdown-doc-relative position by subtracting the size of all input
// gaps before `abs`.
function toRelative(abs, ranges) {
    let pos = abs;
    for (let i = 1; i < ranges.length; i++) {
        let gapFrom = ranges[i - 1].to, gapTo = ranges[i].from;
        if (gapFrom < abs)
            pos -= gapTo - gapFrom;
    }
    return pos;
}
const markdownHighlighting = highlight.styleTags({
    "Blockquote/...": highlight.tags.quote,
    HorizontalRule: highlight.tags.contentSeparator,
    "ATXHeading1/... SetextHeading1/...": highlight.tags.heading1,
    "ATXHeading2/... SetextHeading2/...": highlight.tags.heading2,
    "ATXHeading3/...": highlight.tags.heading3,
    "ATXHeading4/...": highlight.tags.heading4,
    "ATXHeading5/...": highlight.tags.heading5,
    "ATXHeading6/...": highlight.tags.heading6,
    "Comment CommentBlock": highlight.tags.comment,
    Escape: highlight.tags.escape,
    Entity: highlight.tags.character,
    "Emphasis/...": highlight.tags.emphasis,
    "StrongEmphasis/...": highlight.tags.strong,
    "Link/... Image/...": highlight.tags.link,
    "OrderedList/... BulletList/...": highlight.tags.list,
    "BlockQuote/...": highlight.tags.quote,
    "InlineCode CodeText": highlight.tags.monospace,
    "URL Autolink": highlight.tags.url,
    "HeaderMark HardBreak QuoteMark ListMark LinkMark EmphasisMark CodeMark": highlight.tags.processingInstruction,
    "CodeInfo LinkLabel": highlight.tags.labelName,
    LinkTitle: highlight.tags.string,
    Paragraph: highlight.tags.content
});
/**
The default CommonMark parser.
*/
const parser = new MarkdownParser(new common.NodeSet(nodeTypes).extend(markdownHighlighting), Object.keys(DefaultBlockParsers).map(n => DefaultBlockParsers[n]), Object.keys(DefaultBlockParsers).map(n => DefaultLeafBlocks[n]), Object.keys(DefaultBlockParsers), DefaultEndLeaf, DefaultSkipMarkup, Object.keys(DefaultInline).map(n => DefaultInline[n]), Object.keys(DefaultInline), []);

const StrikethroughDelim = { resolve: "Strikethrough", mark: "StrikethroughMark" };
/**
An extension that implements
[GFM-style](https://github.github.com/gfm/#strikethrough-extension-)
Strikethrough syntax using `~~` delimiters.
*/
const Strikethrough = {
    defineNodes: [{
            name: "Strikethrough",
            style: { "Strikethrough/...": highlight.tags.strikethrough }
        }, {
            name: "StrikethroughMark",
            style: highlight.tags.processingInstruction
        }],
    parseInline: [{
            name: "Strikethrough",
            parse(cx, next, pos) {
                if (next != 126 /* '~' */ || cx.char(pos + 1) != 126 || cx.char(pos + 2) == 126)
                    return -1;
                let before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
                let sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
                let pBefore = Punctuation.test(before), pAfter = Punctuation.test(after);
                return cx.addDelimiter(StrikethroughDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
            },
            after: "Emphasis"
        }]
};
// Parse a line as a table row and return the row count. When `elts`
// is given, push syntax elements for the content onto it.
function parseRow(cx, line, startI = 0, elts, offset = 0) {
    let count = 0, first = true, cellStart = -1, cellEnd = -1, esc = false;
    let parseCell = () => {
        elts.push(cx.elt("TableCell", offset + cellStart, offset + cellEnd, cx.parser.parseInline(line.slice(cellStart, cellEnd), offset + cellStart)));
    };
    for (let i = startI; i < line.length; i++) {
        let next = line.charCodeAt(i);
        if (next == 124 /* '|' */ && !esc) {
            if (!first || cellStart > -1)
                count++;
            first = false;
            if (elts) {
                if (cellStart > -1)
                    parseCell();
                elts.push(cx.elt("TableDelimiter", i + offset, i + offset + 1));
            }
            cellStart = cellEnd = -1;
        }
        else if (esc || next != 32 && next != 9) {
            if (cellStart < 0)
                cellStart = i;
            cellEnd = i + 1;
        }
        esc = !esc && next == 92;
    }
    if (cellStart > -1) {
        count++;
        if (elts)
            parseCell();
    }
    return count;
}
function hasPipe(str, start) {
    for (let i = start; i < str.length; i++) {
        let next = str.charCodeAt(i);
        if (next == 124 /* '|' */)
            return true;
        if (next == 92 /* '\\' */)
            i++;
    }
    return false;
}
const delimiterLine = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
class TableParser {
    constructor() {
        // Null means we haven't seen the second line yet, false means this
        // isn't a table, and an array means this is a table and we've
        // parsed the given rows so far.
        this.rows = null;
    }
    nextLine(cx, line, leaf) {
        if (this.rows == null) { // Second line
            this.rows = false;
            let lineText;
            if ((line.next == 45 || line.next == 58 || line.next == 124 /* '-:|' */) &&
                delimiterLine.test(lineText = line.text.slice(line.pos))) {
                let firstRow = [], firstCount = parseRow(cx, leaf.content, 0, firstRow, leaf.start);
                if (firstCount == parseRow(cx, lineText, 0))
                    this.rows = [cx.elt("TableHeader", leaf.start, leaf.start + leaf.content.length, firstRow),
                        cx.elt("TableDelimiter", cx.lineStart + line.pos, cx.lineStart + line.text.length)];
            }
        }
        else if (this.rows) { // Line after the second
            let content = [];
            parseRow(cx, line.text, line.pos, content, cx.lineStart);
            this.rows.push(cx.elt("TableRow", cx.lineStart + line.pos, cx.lineStart + line.text.length, content));
        }
        return false;
    }
    finish(cx, leaf) {
        if (!this.rows)
            return false;
        cx.addLeafElement(leaf, cx.elt("Table", leaf.start, leaf.start + leaf.content.length, this.rows));
        return true;
    }
}
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
const Table = {
    defineNodes: [
        { name: "Table", block: true },
        { name: "TableHeader", style: { "TableHeader/...": highlight.tags.heading } },
        "TableRow",
        { name: "TableCell", style: highlight.tags.content },
        { name: "TableDelimiter", style: highlight.tags.processingInstruction },
    ],
    parseBlock: [{
            name: "Table",
            leaf(_, leaf) { return hasPipe(leaf.content, 0) ? new TableParser : null; },
            endLeaf(cx, line, leaf) {
                if (leaf.parsers.some(p => p instanceof TableParser) || !hasPipe(line.text, line.basePos))
                    return false;
                let next = cx.peekLine();
                return delimiterLine.test(next) && parseRow(cx, line.text, line.basePos) == parseRow(cx, next, line.basePos);
            },
            before: "SetextHeading"
        }]
};
class TaskParser {
    nextLine() { return false; }
    finish(cx, leaf) {
        cx.addLeafElement(leaf, cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
            cx.elt("TaskMarker", leaf.start, leaf.start + 3),
            ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3)
        ]));
        return true;
    }
}
/**
Extension providing
[GFM-style](https://github.github.com/gfm/#task-list-items-extension-)
task list items, where list items can be prefixed with `[ ]` or
`[x]` to add a checkbox.
*/
const TaskList = {
    defineNodes: [
        { name: "Task", block: true, style: highlight.tags.list },
        { name: "TaskMarker", style: highlight.tags.atom }
    ],
    parseBlock: [{
            name: "TaskList",
            leaf(cx, leaf) {
                return /^\[[ xX]\][ \t]/.test(leaf.content) && cx.parentType().name == "ListItem" ? new TaskParser : null;
            },
            after: "SetextHeading"
        }]
};
const autolinkRE = /(www\.)|(https?:\/\/)|([\w.+-]{1,100}@)|(mailto:|xmpp:)/gy;
const urlRE = /[\w-]+(\.[\w-]+)+(:\d+)?(\/[^\s<]*)?/gy;
const lastTwoDomainWords = /[\w-]+\.[\w-]+($|[/:])/;
const emailRE = /[\w.+-]+@[\w-]+(\.[\w.-]+)+/gy;
const xmppResourceRE = /\/[a-zA-Z\d@.]+/gy;
function count(str, from, to, ch) {
    let result = 0;
    for (let i = from; i < to; i++)
        if (str[i] == ch)
            result++;
    return result;
}
function autolinkURLEnd(text, from) {
    urlRE.lastIndex = from;
    let m = urlRE.exec(text);
    if (!m || lastTwoDomainWords.exec(m[0])[0].indexOf("_") > -1)
        return -1;
    let end = from + m[0].length;
    for (;;) {
        let last = text[end - 1], m;
        if (/[?!.,:*_~]/.test(last) ||
            last == ")" && count(text, from, end, ")") > count(text, from, end, "("))
            end--;
        else if (last == ";" && (m = /&(?:#\d+|#x[a-f\d]+|\w+);$/.exec(text.slice(from, end))))
            end = from + m.index;
        else
            break;
    }
    return end;
}
function autolinkEmailEnd(text, from) {
    emailRE.lastIndex = from;
    let m = emailRE.exec(text);
    if (!m)
        return -1;
    let last = m[0][m[0].length - 1];
    return last == "_" || last == "-" ? -1 : from + m[0].length - (last == "." ? 1 : 0);
}
/**
Extension that implements autolinking for
`www.`/`http://`/`https://`/`mailto:`/`xmpp:` URLs and email
addresses.
*/
const Autolink = {
    parseInline: [{
            name: "Autolink",
            parse(cx, next, absPos) {
                let pos = absPos - cx.offset;
                if (pos && /\w/.test(cx.text[pos - 1]))
                    return -1;
                autolinkRE.lastIndex = pos;
                let m = autolinkRE.exec(cx.text), end = -1;
                if (!m)
                    return -1;
                if (m[1] || m[2]) { // www., http://
                    end = autolinkURLEnd(cx.text, pos + m[0].length);
                    if (end > -1 && cx.hasOpenLink) {
                        let noBracket = /([^\[\]]|\[[^\]]*\])*/.exec(cx.text.slice(pos, end));
                        end = pos + noBracket[0].length;
                    }
                }
                else if (m[3]) { // email address
                    end = autolinkEmailEnd(cx.text, pos);
                }
                else { // mailto:/xmpp:
                    end = autolinkEmailEnd(cx.text, pos + m[0].length);
                    if (end > -1 && m[0] == "xmpp:") {
                        xmppResourceRE.lastIndex = end;
                        m = xmppResourceRE.exec(cx.text);
                        if (m)
                            end = m.index + m[0].length;
                    }
                }
                if (end < 0)
                    return -1;
                cx.addElement(cx.elt("URL", absPos, end + cx.offset));
                return end + cx.offset;
            }
        }]
};
/**
Extension bundle containing [`Table`](#Table),
[`TaskList`](#TaskList), [`Strikethrough`](#Strikethrough), and
[`Autolink`](#Autolink).
*/
const GFM = [Table, TaskList, Strikethrough, Autolink];
function parseSubSuper(ch, node, mark) {
    return (cx, next, pos) => {
        if (next != ch || cx.char(pos + 1) == ch)
            return -1;
        let elts = [cx.elt(mark, pos, pos + 1)];
        for (let i = pos + 1; i < cx.end; i++) {
            let next = cx.char(i);
            if (next == ch)
                return cx.addElement(cx.elt(node, pos, i + 1, elts.concat(cx.elt(mark, i, i + 1))));
            if (next == 92 /* '\\' */)
                elts.push(cx.elt("Escape", i, i++ + 2));
            if (space(next))
                break;
        }
        return -1;
    };
}
/**
Extension providing
[Pandoc-style](https://pandoc.org/MANUAL.html#superscripts-and-subscripts)
superscript using `^` markers.
*/
const Superscript = {
    defineNodes: [
        { name: "Superscript", style: highlight.tags.special(highlight.tags.content) },
        { name: "SuperscriptMark", style: highlight.tags.processingInstruction }
    ],
    parseInline: [{
            name: "Superscript",
            parse: parseSubSuper(94 /* '^' */, "Superscript", "SuperscriptMark")
        }]
};
/**
Extension providing
[Pandoc-style](https://pandoc.org/MANUAL.html#superscripts-and-subscripts)
subscript using `~` markers.
*/
const Subscript = {
    defineNodes: [
        { name: "Subscript", style: highlight.tags.special(highlight.tags.content) },
        { name: "SubscriptMark", style: highlight.tags.processingInstruction }
    ],
    parseInline: [{
            name: "Subscript",
            parse: parseSubSuper(126 /* '~' */, "Subscript", "SubscriptMark")
        }]
};
/**
Extension that parses two colons with only letters, underscores,
and numbers between them as `Emoji` nodes.
*/
const Emoji = {
    defineNodes: [{ name: "Emoji", style: highlight.tags.character }],
    parseInline: [{
            name: "Emoji",
            parse(cx, next, pos) {
                let match;
                if (next != 58 /* ':' */ || !(match = /^[a-zA-Z_0-9]+:/.exec(cx.slice(pos + 1, cx.end))))
                    return -1;
                return cx.addElement(cx.elt("Emoji", pos, pos + 1 + match[0].length));
            }
        }]
};

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `attributes`, `attribute`,
 * `identifierAttr`, `classAttr`, `keyValAttr`, and `specialAttr`
 * (starting at line 643 in that revision).
 */
function codePointAt(source, index) {
    if (index >= source.length) {
        return undefined;
    }
    const point = source.codePointAt(index);
    if (point === undefined) {
        return undefined;
    }
    const char = String.fromCodePoint(point);
    return { char, width: char.length };
}
function isLetter(char) {
    return /^\p{L}$/u.test(char);
}
function isAlphaNum(char) {
    return /^[\p{L}\p{N}]$/u.test(char);
}
function isIdentifierTail(char) {
    return isAlphaNum(char) || '-_:'.includes(char) || char === '.';
}
function isPandocEscapable(char) {
    // Pandoc's default markdown reader enables Ext_all_symbols_escapable:
    // any non-alphanumeric symbol except a physical line break may be escaped.
    return char !== '\n' && char !== '\r' && !isAlphaNum(char);
}
function scanIdentifier(source, start, firstMayBeNumber) {
    const first = codePointAt(source, start);
    if (first === undefined || !(firstMayBeNumber ? isAlphaNum(first.char) : isLetter(first.char))) {
        return undefined;
    }
    let index = start + first.width;
    while (true) {
        const next = codePointAt(source, index);
        if (next === undefined || !isIdentifierTail(next.char)) {
            return index;
        }
        index += next.width;
    }
}
/** Pandoc's `spnl`: horizontal space, optionally one line break, then horizontal space. */
function skipSpnl(source, start) {
    let index = start;
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    if (source[index] === '\r' && source[index + 1] === '\n') {
        index += 2;
    }
    else if (source[index] === '\n' || source[index] === '\r') {
        index++;
    }
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    return index;
}
function scanCharacterReference(source, start) {
    const match = /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/.exec(source.slice(start));
    if (match === null) {
        return undefined;
    }
    const decoded = entities.decodeHTMLStrict(match[0]);
    if (decoded === match[0]) {
        return undefined;
    }
    return { to: start + match[0].length, value: decoded };
}
function scanQuotedValue(source, start, quote) {
    let index = start + 1;
    let value = '';
    while (index < source.length) {
        const char = source[index];
        if (char === quote) {
            return { status: 'match', value: { to: index + 1, value } };
        }
        if (char === '\\') {
            if (index + 1 >= source.length) {
                return { status: 'incomplete' };
            }
            const escaped = codePointAt(source, index + 1);
            if (escaped === undefined) {
                return { status: 'incomplete' };
            }
            if (isPandocEscapable(escaped.char)) {
                value += escaped.char;
                index += 1 + escaped.width;
            }
            else {
                value += '\\';
                index++;
            }
            continue;
        }
        if (char === '&') {
            const reference = scanCharacterReference(source, index);
            if (reference !== undefined) {
                value += reference.value;
                index = reference.to;
                continue;
            }
        }
        if (char === '\n' || char === '\r') {
            const newlineWidth = char === '\r' && source[index + 1] === '\n' ? 2 : 1;
            const after = index + newlineWidth;
            let probe = after;
            while (source[probe] === ' ' || source[probe] === '\t') {
                probe++;
            }
            // Pandoc's litChar admits an endline but not a blankline inside a quoted value.
            if (source[probe] === '\n' || source[probe] === '\r') {
                return { status: 'no-match' };
            }
            value += ' ';
            index = after;
            continue;
        }
        const point = codePointAt(source, index);
        if (point === undefined) {
            return { status: 'incomplete' };
        }
        value += point.char;
        index += point.width;
    }
    return { status: 'incomplete' };
}
function scanUnquotedValue(source, start) {
    let index = start;
    let value = '';
    while (index < source.length) {
        const char = source[index];
        if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '}') {
            break;
        }
        if (char === '\\' && index + 1 < source.length) {
            const escaped = codePointAt(source, index + 1);
            if (escaped !== undefined && isPandocEscapable(escaped.char)) {
                value += escaped.char;
                index += 1 + escaped.width;
                continue;
            }
        }
        const point = codePointAt(source, index);
        if (point === undefined) {
            break;
        }
        value += point.char;
        index += point.width;
    }
    return { to: index, value };
}
function scanToken(source, start) {
    const first = source[start];
    if (first === undefined) {
        return { status: 'incomplete' };
    }
    if (first === '#') {
        const to = scanIdentifier(source, start + 1, true);
        return to === undefined
            ? { status: 'no-match' }
            : { status: 'match', value: { kind: 'id', from: start, to, value: source.slice(start + 1, to) } };
    }
    if (first === '.') {
        const to = scanIdentifier(source, start + 1, false);
        return to === undefined
            ? { status: 'no-match' }
            : { status: 'match', value: { kind: 'class', from: start, to, value: source.slice(start + 1, to) } };
    }
    if (first === '-') {
        return { status: 'match', value: { kind: 'special', from: start, to: start + 1, value: 'unnumbered' } };
    }
    const keyEnd = scanIdentifier(source, start, false);
    if (keyEnd === undefined || source[keyEnd] !== '=') {
        return { status: 'no-match' };
    }
    const valueStart = keyEnd + 1;
    const quote = source[valueStart];
    if (quote === '"' || quote === "'") {
        const quoted = scanQuotedValue(source, valueStart, quote);
        if (quoted.status !== 'match') {
            return quoted;
        }
        return {
            status: 'match',
            value: {
                kind: 'key-value',
                from: start,
                to: quoted.value.to,
                key: source.slice(start, keyEnd),
                value: quoted.value.value,
            },
        };
    }
    const unquoted = scanUnquotedValue(source, valueStart);
    return {
        status: 'match',
        value: {
            kind: 'key-value',
            from: start,
            to: unquoted.to,
            key: source.slice(start, keyEnd),
            value: unquoted.value,
        },
    };
}
/** Parse one braced Pandoc attribute list beginning exactly at `start`. */
function scanPandocAttributeList(source, start = 0) {
    if (source[start] !== '{') {
        return { status: 'no-match' };
    }
    let index = skipSpnl(source, start + 1);
    const tokens = [];
    while (true) {
        if (index >= source.length) {
            return { status: 'incomplete' };
        }
        if (source[index] === '}') {
            return { status: 'match', value: { from: start, to: index + 1, tokens } };
        }
        const token = scanToken(source, index);
        if (token.status !== 'match') {
            return token;
        }
        tokens.push(token.value);
        index = skipSpnl(source, token.value.to);
    }
}
/**
 * Parse a Pandoc fenced-div opening starting at offset zero. This mirrors
 * Pandoc's `divFenced`: colon fence, horizontal space, `attributes` or one bare
 * non-space class, horizontal space, optional trailing colons, then endline.
 */
function scanBareDivClass(source, start, markTo) {
    let index = start;
    const from = index;
    while (index < source.length && !/[ \t\r\n]/.test(source[index])) {
        index++;
    }
    if (index === from) {
        return index >= source.length ? { status: 'incomplete' } : { status: 'no-match' };
    }
    const bareClass = { from, to: index, value: source.slice(from, index) };
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    while (source[index] === ':') {
        index++;
    }
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    const headerEnd = index;
    if (index === source.length) {
        return {
            status: 'match',
            value: {
                markFrom: 0,
                markTo,
                bareClass,
                headerEnd,
                headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
            },
        };
    }
    if (source[index] === '\r' && source[index + 1] === '\n') {
        index += 2;
    }
    else if (source[index] === '\n' || source[index] === '\r') {
        index++;
    }
    else {
        return { status: 'no-match' };
    }
    return {
        status: 'match',
        value: {
            markFrom: 0,
            markTo,
            bareClass,
            headerEnd,
            headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
        },
    };
}
function scanPandocFencedDivOpening(source, final = true) {
    let index = 0;
    while (source[index] === ':') {
        index++;
    }
    if (index < 3) {
        return { status: 'no-match' };
    }
    const markTo = index;
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    const attributeStart = index;
    if (source[index] !== '{') {
        return scanBareDivClass(source, attributeStart, markTo);
    }
    const scanned = scanPandocAttributeList(source, index);
    if (scanned.status === 'incomplete') {
        return final ? scanBareDivClass(source, attributeStart, markTo) : scanned;
    }
    if (scanned.status === 'no-match') {
        // Pandoc wraps `attributes` in `try` and then falls back to a bare class.
        return scanBareDivClass(source, attributeStart, markTo);
    }
    const attribute = scanned.value;
    index = attribute.to;
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    while (source[index] === ':') {
        index++;
    }
    while (source[index] === ' ' || source[index] === '\t') {
        index++;
    }
    const headerEnd = index;
    if (index === source.length) {
        return {
            status: 'match',
            value: {
                markFrom: 0,
                markTo,
                attribute,
                headerEnd,
                headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
            },
        };
    }
    if (source[index] === '\r' && source[index + 1] === '\n') {
        index += 2;
    }
    else if (source[index] === '\n' || source[index] === '\r') {
        index++;
    }
    else {
        return { status: 'no-match' };
    }
    return {
        status: 'match',
        value: {
            markFrom: 0,
            markTo,
            attribute,
            headerEnd,
            headerLineCount: source.slice(0, headerEnd).split(/\r?\n|\r/).length,
        },
    };
}

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `attributes` (line 643).
 */
/** Parses Pandoc attribute lists (for example `{#id .class key="value"}`). */
const pandocAttributesParser = {
    name: 'pandoc-attributes',
    parse: (ctx, next, pos) => {
        if (next !== 123) { // 123 === '{'
            return -1;
        }
        const localFrom = pos - ctx.offset;
        const scanned = scanPandocAttributeList(ctx.text, localFrom);
        if (scanned.status !== 'match') {
            return -1;
        }
        const attr = scanned.value;
        const whitespaceBefore = /^\s*$/.test(ctx.slice(pos - 1, pos));
        const whitespaceAfter = /^\s*$/.test(ctx.text.slice(attr.to));
        // Pandoc attributes are either attached directly to a carrier or finish
        // the inline line. A free-standing brace group in running prose is text.
        if (whitespaceBefore && !whitespaceAfter) {
            return -1;
        }
        const from = ctx.offset + attr.from;
        const to = ctx.offset + attr.to;
        return ctx.addElement(ctx.elt('PandocAttribute', from, to, [
            ctx.elt('PandocAttributeMark', from, from + 1),
            ctx.elt('PandocAttributeMark', to - 1, to),
        ]));
    },
};

/**
 * Pandoc citation grammar for the Lezer Markdown fork.
 *
 * Reference implementation: Pandoc 3.10.2, commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs: cite, textualCite, normalCite,
 * citeList, citation, prefix, and suffix (starting at `cite`, line 2230 in
 * that revision). Behavioral acceptance is differential against Pandoc JSON.
 */
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
const locatorLabels = {
    'article-locator': ['Art.', 'Artikel', 'art.', 'arts.', 'article', 'articles'],
    book: ['Buch', 'Bücher', 'B.', 'book', 'books', 'bk.', 'bks.', 'livre', 'livres', 'liv.'],
    canon: ['can.', 'cann.', 'canon', 'canons'],
    chapter: ['Kapitel', 'Kap.', 'chapter', 'chapters', 'c.', 'cc.', 'chap.', 'chaps.', 'chapitre', 'chapitres'],
    column: ['Spalte', 'Spalten', 'Sp.', 'column', 'columns', 'col.', 'cols', 'colonne', 'colonnes'],
    elocation: ['emplact', 'emplacement', 'emplacements', 'loc.', 'locs.', 'location', 'locations'],
    equation: ['équation', 'équations', 'eq.', 'eqq.', 'equation', 'equations'],
    figure: ['Abbildung', 'Abbildungen', 'Abb.', 'figure', 'figures', 'fig.', 'figs'],
    folio: ['Blatt', 'Blätter', 'Fol.', 'folio', 'folios', 'fol.', 'fols', 'fᵒ', 'fᵒˢ'],
    issue: ['Nummer', 'Nummern', 'Nr.', 'number', 'numbers', 'no.', 'nos.', 'numéro', 'numéros', 'nᵒ', 'nᵒˢ'],
    line: ['Zeile', 'Zeilen', 'Z', 'line', 'lines', 'l.', 'll.', 'ligne', 'lignes'],
    note: ['Note', 'Noten', 'N.', 'note', 'notes', 'n.', 'nn.'],
    opus: ['Opus', 'Opera', 'op.', 'opus', 'opera', 'opp.'],
    page: ['Seite', 'Seiten', 'S.', 'page', 'pages', 'p.', 'pp.'],
    paragraph: ['Absatz', 'Absätze', 'Abs.', '¶', '¶¶', 'paragraph', 'paragraphs', 'para.', 'paras', 'paragraphe', 'paragraphes', 'paragr.'],
    part: ['Teil', 'Teile', 'part', 'parts', 'pt.', 'pts', 'partie', 'parties', 'part.'],
    rule: ['règle', 'règles', 'r.', 'rr.', 'rule', 'rules'],
    section: ['Abschnitt', 'Abschnitte', 'Abschn.', '§', '§§', 'section', 'sections', 'sec.', 'secs', 'sect.'],
    'sub-verbo': ['sub verbo', 'sub verbis', 's.&#160;v.', 's.&#160;vv.', 's.v.', 's.vv.'],
    supplement: ['supp.', 'supps.', 'supplement', 'supplements'],
    table: ['tableau', 'tableaux', 'tab.', 'tbl.', 'tbls.', 'table', 'tables'],
    timestamp: [],
    'title-locator': ['titre', 'titres', 'tit.', 'titt.', 'title', 'titles'],
    verse: ['Vers', 'Verse', 'V.', 'verse', 'verses', 'v.', 'vv.', 'verset', 'versets'],
    volume: ['Band', 'Bände', 'Bd.', 'Bde.', 'volume', 'volumes', 'vol.', 'vols.']
};
const sanitizedLocatorLabels = {};
let allValidLocatorLabels = new Set();
for (const key in locatorLabels) {
    // Normalize all labels to lowercase to handle small typos and convert to sets for quicker validation
    const setLabels = new Set(locatorLabels[key].map(e => e.toLowerCase()));
    sanitizedLocatorLabels[key] = setLabels;
    // Flatten all labels for quick validation
    allValidLocatorLabels = allValidLocatorLabels.union(setLabels);
}
// Determine the longest locator length (so that we know below how many
// characters we must extract from the inline context).
const maxLocatorLabelLength = Math.max(...allValidLocatorLabels.values().map(x => x.length));
/**
 * I strongly believe that Marijn's approach of using character codepoints
 * instead of the characters themselves has a good reason, so we are going to
 * stick to the intended usage of the parser. However, I am a human and need
 * some labels for the numbers. This map essentially maps a few relevant code
 * points to their key names.
 */
const CHAR = {
    TAB: 9,
    LF: 10,
    CR: 13,
    SPACE: 32,
    BRACE_OPEN: 40,
    ASTERISK: 42,
    COMMA: 44,
    HYPHEN: 45,
    DOT: 46,
    SEMICOLON: 59,
    AT: 64,
    BRACKET_OPEN: 91,
    BRACKET_CLOSE: 93,
    UNDERSCORE: 95,
    CURLY_OPEN: 123,
    CURLY_CLOSE: 125,
    TILDE: 126
};
// Character code points for upper/lower case roman numerals (CDILMVX).
const ROMAN_NUMERAL_CODES = [
    67, 68, 73, 76, 77, 86, 88, // Uppercase
    99, 100, 105, 108, 109, 118, 120 // Lowercase
];
const CANONICAL_ROMAN_NUMERAL = /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;
// Pandoc keys admit single internal punctuation between Unicode alphanumerics.
// https://pandoc.org/MANUAL.html#citations
const BARE_CITATION_KEY = /^[\p{L}\p{N}_]+(?:[:.#$%&+?<>~\/-][\p{L}\p{N}_]+)*/u;
/**
 * Checks whether the text starts with a complete Roman-numeral locator. The
 * token must end before another letter and every range component must be a
 * canonical Roman numeral. Without these boundaries, suffixes such as
 * "Lemma" and "Corollary" are split after their initial L or C.
 */
function startsWithRomanNumeralLocator(text) {
    var _a;
    const token = (_a = /^[CDILMVX]+(?:-[CDILMVX]+)*/i.exec(text)) === null || _a === void 0 ? void 0 : _a[0];
    if (token === undefined) {
        return false;
    }
    const followingCharacter = text[token.length];
    if (followingCharacter !== undefined && /[A-Za-z]/.test(followingCharacter)) {
        return false;
    }
    return token.split('-').every(part => CANONICAL_ROMAN_NUMERAL.test(part));
}
/**
 * Record of all valid citation node names.
 */
const NODES = {
    /**
     * The containing citation node
     */
    CITATION: 'Citation',
    /**
     * Any citation formatting character (brackets, etc.)
     */
    MARK: 'CitationMark',
    /**
     * Citation prefix
     */
    PREFIX: 'CitationPrefix',
    /**
     * "Suppress author"-flag.
     */
    AUTHORFLAG: 'CitationSuppressAuthorFlag',
    /**
     * The @-sign in front of the citekey
     */
    AT: 'CitationAtSign',
    /**
     * The citation key.
     */
    KEY: 'CitationCitekey',
    /**
     * The locator
     */
    LOCATOR: 'CitationLocator',
    /**
     * The citation suffix.
     */
    SUFFIX: 'CitationSuffix'
};
function parseCitationLocator(text) {
    for (const [label, names] of Object.entries(sanitizedLocatorLabels)) {
        for (const name of names) {
            if (text.toLowerCase().startsWith(name + ' ')) {
                return { locator: text.slice(name.length + 1), label: label };
            }
        }
    }
    return { locator: text };
}
/** Interpret Pandoc's suffix as CSL locator plus the remaining authored affix. */
function parseCitationSuffix(suffix) {
    var _a, _b;
    const authored = suffix.replace(/\u00a0/g, ' ');
    const text = authored.replace(/^,?\s*/, '');
    if (text === '')
        return {};
    const braced = /^\{([^}]*)\}/.exec(text);
    if (braced !== null) {
        return Object.assign(Object.assign({}, parseCitationLocator(braced[1])), { suffix: text.slice(braced[0].length) });
    }
    const parsed = parseCitationLocator(text);
    const locatorText = parsed.locator;
    if (locatorText === undefined)
        throw new Error('Citation locator text is unavailable');
    const numeric = (_a = /^[0-9]+(?:[.\-–][0-9]+)*/.exec(locatorText)) === null || _a === void 0 ? void 0 : _a[0];
    const roman = startsWithRomanNumeralLocator(locatorText) ? (_b = /^[CDILMVX]+(?:-[CDILMVX]+)*/i.exec(locatorText)) === null || _b === void 0 ? void 0 : _b[0] : undefined;
    const locator = numeric !== null && numeric !== void 0 ? numeric : roman;
    if (locator === undefined)
        return { suffix: authored };
    return { locator, label: parsed.label, suffix: locatorText.slice(locator.length) };
}
// Here follows the actual parser
const citationParser = {
    name: 'citations',
    // This inline parser must be run before the Link parser, as
    // `[@citekey, p. 123]` will otherwise be detected as a link.
    before: 'Link',
    // NOTE: I discovered that elements MUST UNDER ALL CIRCUMSTANCES be inserted
    // SORTED. The library will omit any elements added whose from/to positions do
    // not match up with the rest of the elements. (This is especially important
    // for finishing the prefix below).
    parse: (ctx, next, pos) => {
        var _a, _b;
        // Any potentially valid citation starts with an opening bracket, an @, or
        // a hyphen.
        if (next !== CHAR.AT && next !== CHAR.BRACKET_OPEN && next !== CHAR.HYPHEN) {
            return -1;
        }
        // Ensure the character before `pos` is valid. NOTE: The InlineContext may
        // include newlines, since single newlines are considered part of the same
        // line due to the hard wrapping rule.
        const prevChar = ctx.char(pos - 1);
        const validBefore = Number.isNaN(prevChar) || [
            CHAR.BRACE_OPEN,
            CHAR.BRACKET_OPEN,
            CHAR.BRACKET_CLOSE,
            CHAR.ASTERISK,
            CHAR.UNDERSCORE,
            CHAR.TILDE,
            CHAR.LF,
            CHAR.CR,
            CHAR.TAB,
            CHAR.SPACE
        ].includes(prevChar);
        if (!validBefore) {
            return -1;
        }
        // Quick additional check to save us some headaches, because if `next` is a
        // hyphen, it MUST be followed by an @ to be considered a valid citation.
        if (next === CHAR.HYPHEN && ctx.char(pos + 1) !== CHAR.AT) {
            return -1;
        }
        // Now we have two options: If the character was either an @ or a hyphen,
        // we are dealing with an inline-citation. Otherwise, we have a regular
        // in-text citation.
        // What we essentially do below is implement a basic character-parser that
        // collects the various elements of a citation in `parts`, and emits a full
        // citation at the end.
        // NOTE: Each citation has two named elements in a specific order: First a
        // citekey, second an optional locator. Anything before the citekey is by
        // definition the prefix, and anything after the locator (if present,
        // otherwise after the citekey) up until the next semicolon or end bracket
        // is by definition considered suffix.
        // We collect all (non-nesting) children in this array.
        const parts = [];
        // This is necessary, because even a citation with zero proper citekeys will
        // otherwise be detected as valid.
        let citekeysFound = 0;
        // We often need to ensure that we do not overrun the maximum inline context
        // length.
        const ctxEndPos = ctx.offset + ctx.text.length;
        // Preset the current position in our parsing
        let i = pos;
        // First, deal with regular in-text citations, as these are more complex.
        if (next === CHAR.BRACKET_OPEN) {
            // NOTE the increment. These are used in several parts to keep the code a
            // bit cleaner. I have avoided using `i++`, and instead used only `++i` to
            // signal that we are shifting the index.
            parts.push(ctx.elt(NODES.MARK, i, ++i));
            // Set up the state. We have to find two elements within each citation --
            // a citekey, and an optional locator. Prefix and suffix can be computed
            // from that. We ignore everything between citekey and locator.
            let citekeyStart = -1;
            let citekeyEnd = -1;
            let citekeyInBrackets = false;
            let locatorStart = -1;
            let locatorEnd = -1;
            let locatorInBrackets = false;
            // We need this to account for multiple citekeys. It allows us to properly
            // insert prefix-nodes in multi-citekey-citations.
            let citationPartStart = i;
            let closed = false;
            let nestedBrackets = 0;
            // Now go through the character stream and parse the citation parts.
            for ( /* i is at the correct position */; i < ctxEndPos; i++) {
                // NOTE NOTE: Since the individual parsing rules are slightly more
                // complex, I could not use a switch statement, nor an if-else branching
                // since both was less readable than I have wished for. So instead I
                // use individual if-branches that usually end in a `continue` or break.
                // Note that some of those branches do not, meaning they are essentially
                // 'fall-through.'
                // Iteration setup
                const prevCh = ctx.char(i - 1); // Might be Number.NaN
                const ch = ctx.char(i);
                const nextCh = ctx.char(i + 1); // Might be Number.NaN
                if (citekeyInBrackets && citekeyEnd < 0 && i > citekeyStart && ch !== CHAR.CURLY_CLOSE) {
                    if (/\s/u.test(String.fromCharCode(ch)))
                        return -1;
                    continue;
                }
                if (ch === CHAR.BRACKET_OPEN) {
                    nestedBrackets++;
                    continue;
                }
                if (ch === CHAR.BRACKET_CLOSE && nestedBrackets > 0) {
                    nestedBrackets--;
                    continue;
                }
                if (nestedBrackets > 0)
                    continue;
                if (ch === CHAR.SEMICOLON || ch === CHAR.BRACKET_CLOSE) {
                    // Regardless of whether another citation part starts or the entire
                    // citation is now finished, we must close any opened and unfinished
                    // nodes here.
                    if (citekeyStart < 0) {
                        // This happens with bracketed text that does not contain an @-sign.
                        // Up until here, those things will indeed be considered valid, but
                        // we have to explicitly return here to avoid any errors later on.
                        return -1;
                    }
                    else if (locatorStart > -1 && locatorEnd < 0) {
                        // Locator reaches until the end of the part
                        parts.push(ctx.elt(NODES.LOCATOR, locatorStart, i));
                    }
                    else if (locatorEnd > -1 && locatorEnd < i) {
                        // Locator has been finalized -> suffix.
                        parts.push(ctx.elt(NODES.SUFFIX, locatorInBrackets ? locatorEnd + 1 : locatorEnd, i));
                    }
                    else if (citekeyEnd < 0) {
                        // Non-bracketed citekey with no locator and no suffix.
                        parts.push(ctx.elt(NODES.KEY, citekeyStart, i));
                        citekeysFound++;
                    }
                    else if (citekeyEnd < i) {
                        // No locator, but there were characters after the citekey -> suffix
                        parts.push(ctx.elt(NODES.SUFFIX, citekeyEnd, i));
                    }
                }
                if (ch === CHAR.SEMICOLON) {
                    // Multiple citations are divided by semicolons, so afterwards a new
                    // citation part starts -> reset the state.
                    citekeyStart = -1;
                    citekeyEnd = -1;
                    citekeyInBrackets = false;
                    locatorStart = -1;
                    locatorEnd = -1;
                    locatorInBrackets = false;
                    citationPartStart = i + 1; // Next citation starts after the semicolon.
                    parts.push(ctx.elt(NODES.MARK, i, i + 1));
                    continue;
                }
                if (ch === CHAR.BRACKET_CLOSE) {
                    // End-condition -- marks the finish of the entire parsing.
                    parts.push(ctx.elt(NODES.MARK, i, ++i));
                    closed = true;
                    break; // Stop iterating; citation is between pos and i.
                }
                if (citekeyStart < 0 && i === citationPartStart && [CHAR.SPACE, CHAR.LF, CHAR.CR, CHAR.TAB].includes(ch)) {
                    // Whitespace at the start of a citation part separates it from the
                    // preceding semicolon. It is part of the citation syntax, so it must
                    // not end up in the prefix of this part.
                    citationPartStart = i + 1;
                    continue;
                }
                if (ch === CHAR.HYPHEN && citekeyStart < 0 && nextCh === CHAR.AT) {
                    // Suppress-author-flag: Before citekey starts, must be followed by @
                    if (i > citationPartStart) {
                        // Add prefix node. Note that we have to add nodes in proper sorted
                        // order.
                        parts.push(ctx.elt(NODES.PREFIX, citationPartStart, i));
                    }
                    parts.push(ctx.elt(NODES.AUTHORFLAG, i, i + 1));
                    continue;
                }
                if (ch === CHAR.AT && citekeyStart < 0 && [CHAR.SPACE, CHAR.HYPHEN, CHAR.BRACKET_OPEN, CHAR.SEMICOLON].includes(prevCh)) {
                    // Start citekey (must be preceded by [, a space, a semicolon, or -)
                    if (i > citationPartStart && prevCh !== CHAR.HYPHEN) {
                        // Add prefix node. Note that we have to add nodes in proper sorted
                        // order.
                        parts.push(ctx.elt(NODES.PREFIX, citationPartStart, i));
                    }
                    parts.push(ctx.elt(NODES.AT, i, i + 1));
                    citekeyStart = i + 1; // Key excludes the '@'
                    if (ctx.char(citekeyStart) !== CHAR.CURLY_OPEN) {
                        const key = (_a = BARE_CITATION_KEY.exec(ctx.slice(citekeyStart, ctxEndPos))) === null || _a === void 0 ? void 0 : _a[0];
                        if (key === undefined)
                            return -1;
                        citekeyEnd = citekeyStart + key.length;
                        parts.push(ctx.elt(NODES.KEY, citekeyStart, citekeyEnd));
                        citekeysFound++;
                        i = citekeyEnd - 1;
                    }
                    continue;
                }
                if (citekeyStart > -1 && citekeyEnd < 0) {
                    // We are inside the citekey
                    if (i === citekeyStart && ch === CHAR.CURLY_OPEN) {
                        citekeyInBrackets = true; // Citekey is in brackets
                        parts.push(ctx.elt(NODES.MARK, i, i + 1));
                        citekeyStart++;
                    }
                    else if (citekeyInBrackets && ch === CHAR.CURLY_CLOSE) {
                        // Citekey is in brackets, and we found the closing bracket
                        if (i === citekeyStart)
                            return -1;
                        parts.push(ctx.elt(NODES.KEY, citekeyStart, i));
                        citekeysFound++;
                        parts.push(ctx.elt(NODES.MARK, i, i + 1));
                        citekeyEnd = i + 1;
                    }
                    // Else: still inside a citekey, so just swallow the character
                    continue;
                }
                // Now we're past the citekey. There's only a suffix and a locator
                // afterwards. If we find a locator, use it; if we don't, everything
                // else is suffix. NOTE: If there is a locator, anything between citekey
                // end and locator start is going to be ignored.
                if (citekeyEnd > -1 && locatorStart < 0 && ch === CHAR.CURLY_OPEN) {
                    // Locator is present; contained within curly brackets.
                    locatorStart = i + 1;
                    locatorInBrackets = true;
                    parts.push(ctx.elt(NODES.MARK, i, i + 1));
                    continue;
                }
                // Check explicit locator labels first so labels like "liv." or "c." or "v."
                // are never misparsed as implicit Roman numerals.
                const slice = ctx.slice(i, i + maxLocatorLabelLength + 1);
                const lclocIndex = slice.indexOf(' ');
                const lcloc = slice.substring(0, lclocIndex).toLowerCase();
                const explicitLabel = lclocIndex > 0 && allValidLocatorLabels.has(lcloc) ? lcloc : undefined;
                if (citekeyEnd > -1 && locatorStart < 0 && prevCh === CHAR.SPACE && explicitLabel !== undefined) {
                    // First, check if there are only punctuation marks and spaces between
                    // the citekey end and the locator start. If not, we should not detect
                    // this as a locator.
                    if (/^[\s,\.:;+-]*$/.test(ctx.slice(citekeyEnd, i - 1))) {
                        // Found a valid locator label -> begin explicit locator
                        locatorStart = i;
                        // Move i forward until after the space so that the implicit locator
                        // logic can take over. This way, regardless of how a locator starts,
                        // its end will be found the same way.
                        i += explicitLabel.length + 1;
                    }
                    continue;
                }
                // Implicit locators: digits or canonical Roman numerals
                const startsImplicitLocator = (ch >= 48 && ch <= 57) || startsWithRomanNumeralLocator(ctx.slice(i, ctxEndPos));
                if (citekeyEnd > -1 && locatorStart < 0 && prevCh === CHAR.SPACE && startsImplicitLocator) {
                    // First, check if there are only punctuation marks and spaces between
                    // the citekey end and the locator start. If not, we should not detect
                    // this as a locator.
                    if (/^[\s,\.:;+-]*$/.test(ctx.slice(citekeyEnd, i - 1))) {
                        // Found a number -> begin implicit locator
                        locatorStart = i;
                    }
                    continue;
                }
                if (locatorStart > -1 && locatorEnd < 0) {
                    // We are inside the locator
                    if (locatorInBrackets && ch === CHAR.CURLY_CLOSE) {
                        // Curly brackets locators are easy
                        locatorEnd = i;
                        // Bracketed locators can be empty ({}) -> in that case do not add
                        // it to the syntax tree.
                        if (locatorEnd > locatorStart) {
                            parts.push(ctx.elt(NODES.LOCATOR, locatorStart, locatorEnd));
                        }
                        parts.push(ctx.elt(NODES.MARK, i, i + 1));
                        continue;
                    }
                    else if (((ch < 48 || ch > 57) && !ROMAN_NUMERAL_CODES.includes(ch) && ch !== CHAR.HYPHEN && ch !== CHAR.DOT)) {
                        // Both implicit and explicit locators end if we no longer have
                        // valid (implicit) locator characters.
                        locatorEnd = i;
                        parts.push(ctx.elt(NODES.LOCATOR, locatorStart, locatorEnd));
                        continue;
                    }
                }
            }
            if (!closed) {
                return -1;
            }
        }
        else {
            // Inline-citation. That one is easier, albeit not without issues.
            // However, until the optional locator/suffix, we can essentially move
            // linearly through the character stream.
            if (next === CHAR.HYPHEN) {
                parts.push(ctx.elt(NODES.AUTHORFLAG, i, ++i));
            }
            // We know that the next character is an @
            parts.push(ctx.elt(NODES.AT, i, ++i));
            let citekeyStart = i;
            // Now we essentially just swallow every allowed character for the citekey.
            if (ctx.char(i) === CHAR.CURLY_OPEN) {
                citekeyStart++;
                parts.push(ctx.elt(NODES.MARK, i, ++i));
                while (i < ctxEndPos && ctx.char(i) !== CHAR.CURLY_CLOSE) {
                    if (/\s/u.test(String.fromCharCode(ctx.char(i))))
                        return -1;
                    i++;
                }
                if (ctx.char(i) !== CHAR.CURLY_CLOSE || i === citekeyStart) {
                    return -1; // Curly bracket didn't close
                }
                parts.push(ctx.elt(NODES.KEY, citekeyStart, i));
                citekeysFound++;
                parts.push(ctx.elt(NODES.MARK, i, ++i));
            }
            else {
                const key = (_b = BARE_CITATION_KEY.exec(ctx.slice(i, ctxEndPos))) === null || _b === void 0 ? void 0 : _b[0];
                if (key === undefined)
                    return -1;
                i += key.length;
                // Note that we need not check for whether i = ctxEndPos, since the
                // citation is allowed to be the last thing within the inline context.
                parts.push(ctx.elt(NODES.KEY, citekeyStart, i));
                citekeysFound++;
            }
            // At this point we are guaranteed to have a citekey. Next, check if there
            // is a locator/suffix bracket. Must be separated from the citekey by a
            // space, and must not start a new bracketed citation (e.g. `[@...]` or `[-@...]`).
            const hasBracket = i < ctxEndPos - 1 && ctx.char(i) === CHAR.SPACE && ctx.char(i + 1) === CHAR.BRACKET_OPEN;
            const isBracketedCitation = hasBracket && (ctx.char(i + 2) === CHAR.AT ||
                (ctx.char(i + 2) === CHAR.HYPHEN && ctx.char(i + 3) === CHAR.AT));
            if (hasBracket && !isBracketedCitation) {
                // Yes, there seems to be a locator bracket.
                // Remember the end of the citekey if the bracket turns out to not be
                // closed, so we can reset i and the citation element will be correct.
                const citekeyEnd = i;
                // In this branch, we only temporarliy collect all elements, since we do
                // not yet know if the bracket actually closes. If it doesn't, anything
                // until the citekey is still valid, but the rest must be thrown away.
                const temporaryParts = [];
                i++;
                temporaryParts.push(ctx.elt(NODES.MARK, i, ++i));
                let intextSuffixStart = i;
                // Does the remaining slice start with an explicit locator label?
                let locatorStart = -1;
                const slice = ctx.slice(i, i + maxLocatorLabelLength + 1);
                const lclocIndex = slice.indexOf(' ');
                const lcloc = slice.substring(0, lclocIndex).toLowerCase();
                // The label must be followed by a space, so `lclocIndex` must be greater than 0
                const explicitLabel = lclocIndex > 0 && allValidLocatorLabels.has(lcloc) ? lcloc : undefined;
                if (explicitLabel !== undefined) {
                    locatorStart = i;
                    // Move i forward until after the space so that the implicit locator
                    // logic can take over
                    i += explicitLabel.length + 1;
                }
                else if (((ctx.char(i) >= 48 && ctx.char(i) <= 57) || ROMAN_NUMERAL_CODES.includes(ctx.char(i)))) {
                    // Found a valid locator character -> begin implicit locator
                    locatorStart = i;
                }
                if (locatorStart > -1) {
                    // There was an implicit or explicit locator; so now we just have to
                    // move i forward until no more valid locator chars exist
                    while (i < ctxEndPos && ((ctx.char(i) >= 48 && ctx.char(i) <= 57) || ROMAN_NUMERAL_CODES.includes(ctx.char(i)) || ctx.char(i) === CHAR.HYPHEN || ctx.char(i) === CHAR.DOT)) {
                        i++;
                    }
                    temporaryParts.push(ctx.elt(NODES.LOCATOR, locatorStart, i));
                    intextSuffixStart = i;
                } // Else: No locator, so essentially everything is suffix.
                // Finally, we just have to find the closing bracket to complete the
                // inline suffix.
                let bracketDepth = 1;
                while (i < ctxEndPos) {
                    if (ctx.char(i) === CHAR.BRACKET_OPEN)
                        bracketDepth++;
                    if (ctx.char(i) === CHAR.BRACKET_CLOSE)
                        bracketDepth--;
                    if (bracketDepth === 0)
                        break;
                    i++;
                }
                if (ctx.char(i) === CHAR.BRACKET_CLOSE) {
                    // First, commit the temporary collected parts ...
                    parts.push(...temporaryParts);
                    // ... add the suffix (intextSuffixStart is sensitive to locator) ...
                    if (intextSuffixStart < i) {
                        parts.push(ctx.elt(NODES.SUFFIX, intextSuffixStart, i));
                    }
                    // ... and close off with the close marker
                    parts.push(ctx.elt(NODES.MARK, i, ++i));
                }
                else {
                    // Bracket did not actually close -> reset i
                    i = citekeyEnd;
                }
            } // else: No locator/suffix bracket, keep the found citekey.
        }
        // Essentially, this `if` branch requires that a valid citation must have
        // at least one part and at least one citekey. This is just a final sanity
        // check as otherwise bracketed text would be considered a citation. In
        // several parts of the code we assume that a citation MUST have at least
        // one citekey.
        if (parts.length > 0 && citekeysFound > 0) {
            // Final step: Compose the full citation element.
            return ctx.addElement(ctx.elt(NODES.CITATION, pos, i, parts));
        }
        else {
            return -1;
        }
    }
};

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `divFenced` (line 2169),
 * `divFenceEnd`, and `bracketedSpan` (line 1916).
 */
const PandocSpanDelimiter = {};
const pandocDivClosingRe = /^(?<mark>:{3,})\s*$/d;
function blockInput$1(ctx) {
    return ctx.input;
}
function readPhysicalLine(input, start) {
    let cursor = start;
    let text = '';
    while (cursor < input.length) {
        const chunk = input.chunk(cursor);
        if (chunk.length === 0) {
            break;
        }
        const newline = chunk.indexOf('\n');
        if (newline !== -1) {
            text += chunk.slice(0, newline + 1);
            return { text, next: cursor + newline + 1, eof: false };
        }
        text += chunk;
        cursor += chunk.length;
    }
    return { text, next: cursor, eof: true };
}
/**
 * Read only as many physical lines as the Pandoc attribute scanner asks for.
 * No BlockContext state moves until a complete, valid opening has been found.
 */
function scanDivOpening(ctx) {
    const input = blockInput$1(ctx);
    let cursor = ctx.parsedPos;
    let source = '';
    while (true) {
        const line = readPhysicalLine(input, cursor);
        source += line.text;
        const scanned = scanPandocFencedDivOpening(source, line.eof);
        if (scanned.status === 'match') {
            return scanned.value;
        }
        if (scanned.status === 'no-match' || line.eof) {
            return undefined;
        }
        cursor = line.next;
    }
}
const pandocSpanParser = {
    name: 'pandoc-span',
    before: 'Link',
    parse: (ctx, next, pos) => {
        if (next === 91) { // 91 === '['
            ctx.addDelimiter(PandocSpanDelimiter, pos, pos + 1, true, false);
            // Return -1 so that the default link parser can add delimiters
            return -1;
        }
        if (next !== 93) { // 93 === ']'
            return -1;
        }
        const localAttrFrom = pos - ctx.offset + 1;
        const scanned = scanPandocAttributeList(ctx.text, localAttrFrom);
        if (scanned.status !== 'match') {
            return -1;
        }
        const opening = ctx.findOpeningDelimiter(PandocSpanDelimiter);
        if (opening === null) {
            return -1;
        }
        const delim = ctx.getDelimiterAt(opening);
        if (delim === null) {
            return -1;
        }
        const attrFrom = ctx.offset + scanned.value.from;
        const attrTo = ctx.offset + scanned.value.to;
        const attr = ctx.elt('PandocAttribute', attrFrom, attrTo, [
            ctx.elt('PandocAttributeMark', attrFrom, attrFrom + 1),
            ctx.elt('PandocAttributeMark', attrTo - 1, attrTo),
        ]);
        const innerElements = ctx.takeContent(opening);
        ctx.addDelimiter(PandocSpanDelimiter, pos, pos + 1, false, true);
        const openingMark = ctx.elt('PandocSpanMark', delim.from, delim.to);
        const closingMark = ctx.elt('PandocSpanMark', pos, pos + 1);
        return ctx.addElement(ctx.elt('PandocSpan', delim.from, attrTo, [openingMark, ...innerElements, closingMark, attr]));
    }
};
/**
 * Helper function to determine the number of parent PandocDivs
 */
function getNestingLevel(ctx) {
    let depth = 1;
    for (let n = ctx.depth - 1; n >= 0; n--) {
        if (ctx.parentType(n).is('PandocDiv')) {
            depth++;
        }
    }
    return depth;
}
const pandocDivParser = {
    name: 'pandoc-div',
    parse: (ctx, line) => {
        if (line.pos > 0) {
            return false;
        }
        const opening = scanDivOpening(ctx);
        if (opening === undefined) {
            return false;
        }
        const openingLineStart = ctx.lineStart;
        const nestingValue = getNestingLevel(ctx) + 1;
        // The opening attribute list may span physical lines. It has already been
        // recognized without moving the block parser, so advancing now is a commit,
        // not speculative parsing.
        for (let lineNumber = 1; lineNumber < opening.headerLineCount; lineNumber++) {
            if (!ctx.nextLine()) {
                return false; // Defensive: a matched scan cannot normally reach this.
            }
        }
        // startComposite computes its start relative to the CURRENT physical line.
        // A negative offset is therefore exactly what preserves the original fence
        // position after a multiline opening header has been consumed.
        ctx.startComposite('PandocDiv', openingLineStart - ctx.lineStart, nestingValue);
        const absolute = (relative) => openingLineStart + relative;
        ctx.addElement(ctx.elt('PandocDivMark', absolute(opening.markFrom), absolute(opening.markTo)));
        if (opening.bareClass !== undefined) {
            ctx.addElement(ctx.elt('PandocDivInfo', absolute(opening.bareClass.from), absolute(opening.bareClass.to)));
        }
        if (opening.attribute !== undefined) {
            const from = absolute(opening.attribute.from);
            const to = absolute(opening.attribute.to);
            ctx.addElement(ctx.elt('PandocAttribute', from, to, [
                ctx.elt('PandocAttributeMark', from, from + 1),
                ctx.elt('PandocAttributeMark', to - 1, to),
            ]));
        }
        // Nothing after the completed opening syntax is body content. Move the
        // current physical line to its end; normal composite parsing resumes on the
        // following line.
        line.moveBase(line.text.length);
        return null;
    },
    endLeaf: (ctx, line, _leaf) => {
        if (ctx.parentType().name === 'PandocDiv') {
            return pandocDivClosingRe.test(line.text) || scanDivOpening(ctx) !== undefined;
        }
        return pandocDivClosingRe.test(line.text);
    },
};
// This function is used in the node [composite](https://github.com/lezer-parser/markdown?tab=readme-ov-file#user-content-nodespec.composite) method:
//
// If this is a composite block, this should hold a function that,
// at the start of a new line where that block is active, checks
// whether the composite block should continue (return value) and
// optionally adjusts the line's base position and registers nodes
// for any markers involved in the block's syntax.
function pandocDivComposite(ctx, line, value) {
    var _a;
    // We only want to end the block if the nesting level, `value`,
    // matches the number of parent PandocDivs so that other parent
    // blocks are not ended early.
    if (value !== getNestingLevel(ctx)) {
        return true;
    }
    const match = pandocDivClosingRe.exec(line.text);
    if (!((_a = match === null || match === void 0 ? void 0 : match.indices) === null || _a === void 0 ? void 0 : _a.groups)) {
        return true;
    }
    const [markFrom, markTo] = match.indices.groups.mark;
    const from = ctx.lineStart + markFrom;
    const to = ctx.lineStart + markTo;
    // Add the closing marker and move the line position
    // up so that we do not re-parse the text.
    line.addMarker(ctx.elt('PandocDivMark', from, to));
    line.moveBase(to);
    return false;
}

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `note` (line 2076) and
 * `inlineNote` (line 2100).
 */
const FootnoteDelimiter = {};
const validFootnoteRe = /^[^\s\^\[\]]+$/;
// Group 1 is the label alone; the body may start after a space or on the next
// line, so the separator is a space *or* the end of the line.
const footnoteRefRe = /^(\[\^[^\s\^\[\]]+\]:)(?:\s|$)/;
const footnoteParser = {
    name: 'footnotes',
    before: 'Link', // [^1] will otherwise be detected as a link
    parse(ctx, next, pos) {
        if (next !== 91 && next !== 94 && next !== 93) { // 91 === '[', 94 === '^', 93 === ']'
            return -1;
        }
        // Footnote Style: [^identifier]
        if (next === 91 && ctx.char(pos + 1) === 94) { // 91 === '[', 94 === '^'
            ctx.addDelimiter(FootnoteDelimiter, pos, pos + 2, true, false);
            // We return -1 here so that the link parser can add its delimiters
            // since [^invalid id](my url) is a valid link otherwise.
            return -1;
        }
        // Footnote Style: ^[inline]
        if (next === 94 && ctx.char(pos + 1) === 91) {
            return ctx.addDelimiter(FootnoteDelimiter, pos, pos + 2, true, false);
        }
        let opening = null;
        if (next === 93) { // 93 === ']'
            opening = ctx.findOpeningDelimiter(FootnoteDelimiter);
        }
        if (opening === null) {
            return -1;
        }
        const delim = ctx.getDelimiterAt(opening);
        if (delim === null) {
            return -1;
        }
        // Inline footnotes can contain markup, however, identifier footnotes cannot.
        const isInline = ctx.char(delim.from) === 94; // 94 === '^'
        // Finally, check if the identifier is valid
        if (!isInline && !validFootnoteRe.test(ctx.slice(delim.to, pos))) {
            return -1;
        }
        const children = ctx.takeContent(opening);
        ctx.addDelimiter(FootnoteDelimiter, pos, pos + 1, false, true);
        return ctx.addElement(ctx.elt('Footnote', delim.from, pos + 1, isInline ? children : undefined));
    }
};
const footnoteRefParser = {
    name: 'footnote-refs',
    parse(ctx, line) {
        // This prevents footnotes from nesting into footnotes
        // and it prevents infinite recursion and OOM errors.
        if (ctx.depth > 1) {
            return false;
        }
        const match = footnoteRefRe.exec(line.text);
        if (!match) {
            return false;
        }
        ctx.startComposite('FootnoteRef', 0);
        ctx.addElement(ctx.elt('FootnoteRefLabel', ctx.lineStart, ctx.lineStart + match[1].length));
        line.moveBaseColumn(match[0].length);
        return null;
    },
    // This is required since the composite block technically starts a `Paragraph`,
    // so in order for stacked footnotes, we have to be able to interrupt paragraph blocks.
    // But we only need to do this for paragraphs which are direct children of a `FootnoteRef`
    endLeaf(ctx, line, _leaf) {
        if (ctx.parentType().name === 'FootnoteRef') {
            return footnoteRefRe.test(line.text);
        }
        return false;
    }
};
function footnoteComposite(ctx, line, _value) {
    // If the line is indented, or the line is empty and the next line is indented.
    if (line.indent >= 4 || (/^\s*$/.test(line.text) && /^([ ]{4,}|\t)/.test(ctx.peekLine()))) {
        line.moveBaseColumn(4);
        return true;
    }
    return false;
}

/**
 * Pandoc YAML metadata block grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Metadata.hs `yamlMetaBlock` (line 171) and
 * `stopLine`, called by Text/Pandoc/Readers/Markdown.hs `yamlMetaBlock'`
 * (line 310). The editor's YAML language mount is deliberately outside this
 * package; this module owns only Markdown syntax.
 */
const frontmatterParser = {
    name: 'frontmatter',
    before: 'HorizontalRule',
    parse: (ctx, line) => {
        // Pandoc's YAML metadata block is a block parser, not a document-prologue
        // parser. It may occur after ordinary blocks as long as `---` starts the
        // current block.
        if (line.text !== '---') {
            return false;
        }
        const openingStart = ctx.lineStart + line.pos;
        const yamlLines = [];
        while (ctx.nextLine() && !/^(?:-{3}|\.{3})$/.test(line.text)) {
            yamlLines.push(line.text);
        }
        if (!/^(?:-{3}|\.{3})$/.test(line.text)) {
            return false;
        }
        if (yamlLines.length > 0 && yamlLines[0].trim() === '') {
            return false;
        }
        const wrapperNode = ctx.elt('YAMLFrontmatter', openingStart, ctx.lineStart + 3, [
            ctx.elt('YAMLFrontmatterStart', openingStart, openingStart + 3),
            ctx.elt('CodeText', openingStart + 4, ctx.lineStart - 1),
            ctx.elt('YAMLFrontmatterEnd', ctx.lineStart, ctx.lineStart + 3)
        ]);
        ctx.nextLine();
        ctx.addElement(wrapperNode);
        return true;
    }
};

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `source` (line 1853), `link`
 * (line 1907), `regLink`, and `referenceLink`.
 */
const PandocLinkDelimiter = {};
// Pandoc `source` permits an empty destination, so `[]()` is a real Link with
// an empty target rather than falling back to literal source.
const linkClosingRe = /^\]\((?<url>.*)\)/;
// Pandoc `linkTitle` is deliberately narrower than CommonMark's title syntax:
// only single- or double-quoted titles are accepted here. Parenthesized text
// belongs to `sourceURL` via `parenthesizedChars`, so `[x](foo (bar))` links to
// `foo (bar)` and has no title. See Markdown.hs `source` / `linkTitle`.
const linkTitleRe = /(?:^|[ \t\r\n]+)(?:"(?<double>(?:\\.|[^"])*)"|'(?<single>(?:\\.|[^'])*)')$/d;
const pandocLinkParser = {
    name: 'pandoc-link-parser',
    before: 'Link',
    parse: (ctx, next, pos) => {
        var _a, _b, _c, _d;
        if (next === 91) { // 91 === '['
            ctx.addDelimiter(PandocLinkDelimiter, pos, pos + 1, true, false);
            // Return -1 so that the default link parser can add delimiters
            return -1;
        }
        if (next === 33 && ctx.char(pos + 1) === 91) { // 33 === '!', 91 === '['
            ctx.addDelimiter(PandocLinkDelimiter, pos, pos + 2, true, false);
            // Return -1 so that the default link parser can add delimiters
            return -1;
        }
        if (next !== 93) { // 93 === ']'
            return -1;
        }
        // If there's no valid URL, return so the default parser can handle
        // the other link types.
        const match = linkClosingRe.exec(ctx.text.slice(pos - ctx.offset));
        if (!(match === null || match === void 0 ? void 0 : match.groups)) {
            return -1;
        }
        const opening = ctx.findOpeningDelimiter(PandocLinkDelimiter);
        if (opening === null) {
            return -1;
        }
        const delim = ctx.getDelimiterAt(opening);
        if (!delim) {
            return -1;
        }
        const isLink = delim.to - delim.from === 1;
        let linkContents = ctx.takeContent(opening);
        ctx.addDelimiter(PandocLinkDelimiter, pos, pos + 1, false, true);
        // Remove nested links, which are invalid
        if (isLink) {
            const linkType = (_a = ctx.parser.nodeSet.types.find(node => node.is('Link'))) === null || _a === void 0 ? void 0 : _a.id;
            const urlType = (_b = ctx.parser.nodeSet.types.find(node => node.is('URL'))) === null || _b === void 0 ? void 0 : _b.id;
            linkContents = linkContents.filter(el => el.type !== linkType && el.type !== urlType);
        }
        // The url may contain additional parenthesis, so we need
        // to count the internal ones to track potential matching pairs
        // to find the external matching closing one.
        let depth = 0;
        let stop = 0;
        let url = match.groups.url;
        while (stop <= url.length) {
            const char = url.charAt(stop);
            // Found the closing parenthesis
            if (char === ')' && depth === 0) {
                break;
            }
            if (char === ')') {
                depth--;
            }
            if (char === '(') {
                depth++;
            }
            stop++;
        }
        url = url.substring(0, stop);
        let destination = url;
        const urlContents = [];
        const title = linkTitleRe.exec(destination);
        if ((_c = title === null || title === void 0 ? void 0 : title.indices) === null || _c === void 0 ? void 0 : _c.groups) {
            destination = url.substring(0, title.index);
            const linkTitleIndices = (_d = title.indices.groups.double) !== null && _d !== void 0 ? _d : title.indices.groups.single;
            if (linkTitleIndices === undefined) {
                return -1;
            }
            urlContents.push(ctx.elt('LinkTitle', pos + 2 + linkTitleIndices[0], pos + 2 + linkTitleIndices[1]));
        }
        urlContents.unshift(ctx.elt('URL', pos + 2, pos + 2 + destination.length));
        const openingUrlMark = ctx.elt('LinkMark', pos + 1, pos + 2);
        const closingUrlMark = ctx.elt('LinkMark', pos + 2 + url.length, pos + 3 + url.length);
        const openingMark = ctx.elt('LinkMark', delim.from, delim.to);
        const closingMark = ctx.elt('LinkMark', pos, pos + 1);
        // This child node structure mirrors the codemirror Link structure
        const children = [openingMark, ...linkContents, closingMark, openingUrlMark, ...urlContents, closingUrlMark];
        return ctx.addElement(ctx.elt(isLink ? 'Link' : 'Image', delim.from, pos + 3 + url.length, children));
    }
};

/**
 * Pandoc TeX-math grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Parsing/Math.hs `mathInlineWith`, `mathDisplayWith`,
 * `mathInline`, and `mathDisplay`; Markdown integration is
 * src/Text/Pandoc/Readers/Markdown.hs `math` (line 1669).
 *
 * The fork emits the existing Lezer CodeMark/CodeText containers so editor
 * consumers remain source-compatible. Recognition, however, follows Pandoc;
 * presentation/language mounting is not part of the grammar.
 */
function isSpaceChar(value) {
    return /\s/u.test(value);
}
function skipBalancedTextCommand(text, from) {
    if (!text.startsWith('\\text{', from))
        return from;
    let depth = 1;
    let cursor = from + 6;
    let escaped = false;
    while (cursor < text.length && depth > 0) {
        const ch = text[cursor];
        if (escaped) {
            escaped = false;
            cursor++;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            cursor++;
            continue;
        }
        if (ch === '{')
            depth++;
        if (ch === '}')
            depth--;
        cursor++;
    }
    return depth === 0 ? cursor : from;
}
function inlineMathEnd(text, from, open, close) {
    var _a, _b;
    const contentFrom = from + open.length;
    if (open === '$' && (contentFrom >= text.length || isSpaceChar(text[contentFrom])))
        return -1;
    let cursor = contentFrom;
    let sawContent = false;
    while (cursor < text.length) {
        if (text.startsWith(close, cursor)) {
            if (!sawContent)
                return -1;
            const before = (_a = text[cursor - 1]) !== null && _a !== void 0 ? _a : '';
            const after = (_b = text[cursor + close.length]) !== null && _b !== void 0 ? _b : '';
            if (!isSpaceChar(before) && !/[0-9]/u.test(after))
                return cursor + close.length;
        }
        if (text[cursor] === '\\') {
            const afterText = skipBalancedTextCommand(text, cursor);
            if (afterText !== cursor) {
                sawContent = true;
                cursor = afterText;
                continue;
            }
            if (cursor + 1 < text.length) {
                sawContent = true;
                cursor += 2;
                continue;
            }
        }
        if (text[cursor] === '\n' && text[cursor + 1] === '\n')
            return -1;
        if (!isSpaceChar(text[cursor]))
            sawContent = true;
        cursor++;
    }
    return -1;
}
function displayMathEnd(text, from, open, close) {
    const contentFrom = from + open.length;
    let cursor = contentFrom;
    let sawContent = false;
    while (cursor < text.length) {
        if (text.startsWith(close, cursor)) {
            return sawContent ? cursor + close.length : -1;
        }
        if (text[cursor] === '\n' && text[cursor + 1] === '\n')
            return -1;
        sawContent = true;
        cursor++;
    }
    return -1;
}
function mathElement(ctx, from, to, openLength, closeLength) {
    const contentFrom = from + openLength;
    const contentTo = to - closeLength;
    return ctx.elt('InlineCode', from, to, [
        ctx.elt('CodeMark', from, contentFrom),
        ctx.elt('CodeText', contentFrom, contentTo),
        ctx.elt('CodeMark', contentTo, to),
    ]);
}
const inlineMathParser = {
    name: 'pandoc-tex-math-dollars',
    before: 'Escape',
    parse: (ctx, next, pos) => {
        if (next !== 36)
            return -1;
        const relative = pos - ctx.offset;
        const display = ctx.text.startsWith('$$', relative);
        const open = display ? '$$' : '$';
        const close = open;
        const localEnd = display
            ? displayMathEnd(ctx.text, relative, open, close)
            : inlineMathEnd(ctx.text, relative, open, close);
        if (localEnd < 0)
            return -1;
        const to = ctx.offset + localEnd;
        return ctx.addElement(mathElement(ctx, pos, to, open.length, close.length));
    }
};
const singleBackslashMathParser = {
    name: 'pandoc-tex-math-single-backslash',
    before: 'Escape',
    parse: (ctx, next, pos) => {
        if (next !== 92)
            return -1;
        const relative = pos - ctx.offset;
        const second = ctx.text[relative + 1];
        if (second !== '(' && second !== '[')
            return -1;
        const open = second === '(' ? '\\(' : '\\[';
        const close = second === '(' ? '\\)' : '\\]';
        const localEnd = second === '('
            ? inlineMathEnd(ctx.text, relative, open, close)
            : displayMathEnd(ctx.text, relative, open, close);
        if (localEnd < 0)
            return -1;
        const to = ctx.offset + localEnd;
        return ctx.addElement(mathElement(ctx, pos, to, open.length, close.length));
    }
};
const DOLLAR_DISPLAY_LINE = /^(\s*\$\$)\s*$/u;
const BRACKET_DISPLAY_LINE = /^\s*\\\[\s*$/u;
const BLANK_LINE = /^\s*$/u;
const blockMathParser = {
    name: 'pandoc-display-math-block',
    parse: (ctx, line) => {
        const dollar = DOLLAR_DISPLAY_LINE.test(line.text);
        const bracket = !dollar && BRACKET_DISPLAY_LINE.test(line.text);
        if (!dollar && !bracket)
            return false;
        const blockStart = ctx.lineStart;
        const contentFrom = ctx.lineStart + line.text.length + 1;
        let closeFrom = -1;
        let closeTo = -1;
        let contentTo = -1;
        while (ctx.nextLine()) {
            if (BLANK_LINE.test(line.text))
                return false;
            if (dollar && DOLLAR_DISPLAY_LINE.test(line.text)) {
                closeFrom = ctx.lineStart;
                closeTo = ctx.lineStart + line.text.length;
                contentTo = ctx.prevLineEnd();
                break;
            }
            if (bracket) {
                const at = line.text.indexOf('\\]');
                if (at >= 0) {
                    closeFrom = ctx.lineStart + at;
                    closeTo = closeFrom + 2;
                    contentTo = closeFrom;
                    break;
                }
            }
        }
        if (closeFrom < 0)
            return false;
        ctx.addElement(ctx.elt('FencedCode', blockStart, closeTo, [
            ctx.elt('CodeMark', blockStart, contentFrom - 1),
            ctx.elt('CodeText', contentFrom, contentTo),
            ctx.elt('CodeMark', closeFrom, closeTo),
        ]));
        ctx.nextLine();
        return true;
    }
};

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/LaTeX.hs `rawLaTeXBlock` (line 153),
 * `rawLaTeXInline` (line 196), `blockCommands`, and `treatAsBlock`;
 * Markdown integration is src/Text/Pandoc/Readers/Markdown.hs
 * `rawLaTeXInline'` (line 2113) under Ext_raw_tex.
 */
/**
 * Pure recognition of Pandoc-style raw LaTeX environment blocks.
 *
 * This module deliberately knows nothing about CodeMirror. The editor parser,
 * custom Markdown AST, linting, and renderer adapters all use the same rules so
 * structural recognition cannot drift between surfaces.
 */
/**
 * Environments consumed by Pandoc's LaTeX `inlineEnvironment` parser. When
 * raw TeX is enabled in the Markdown reader these become RawInline(tex), not
 * RawBlock and not Math.
 *
 * Reference: Pandoc 3.10.2 commit f2ee5dfee866aab007a33552acc6bc01810c6918,
 * Text/Pandoc/Readers/LaTeX/Math.hs `inlineEnvironments` (lines 97-123),
 * reached from Text/Pandoc/Readers/LaTeX.hs `inline` / `rawLaTeXInline`.
 */
const PANDOC_INLINE_ENVIRONMENTS = new Set([
    "displaymath", "math",
    "equation", "equation*", "gather", "gather*", "multline", "multline*",
    "eqnarray", "eqnarray*", "align", "align*", "alignat", "alignat*",
    "flalign", "flalign*", "dmath", "dmath*", "dgroup", "dgroup*",
    "darray", "darray*", "subequations",
]);
const ENVIRONMENT_OPEN_RE = /^\\begin\{([A-Za-z@]+\*?)\}/u;
const CONTROL_SEQUENCE_RE = /^\\([A-Za-z@]+)(\*)?/u;
/** Pandoc 3.10.2 Text.Pandoc.Readers.LaTeX blockCommands + treatAsBlock. */
const PANDOC_BLOCK_COMMANDS = new Set([
    "PackageError",
    "addbibresource",
    "addcontentsline",
    "address",
    "addtocontents",
    "addtocounter",
    "author",
    "bibliography",
    "bibliographystyle",
    "blockcquote",
    "blockquote",
    "caption",
    "centerline",
    "chapter",
    "clearpage",
    "closing",
    "colorbox",
    "date",
    "dedication",
    "documentclass",
    "endinput",
    "epigraph",
    "extratitle",
    "fancybreak",
    "foreignblockcquote",
    "foreignblockquote",
    "framesubtitle",
    "frametitle",
    "frontispiece",
    "graphicspath",
    "hrule",
    "hspace",
    "hyperdef",
    "hypertarget",
    "hyphenblockcquote",
    "hyphenblockquote",
    "iftoggle",
    "ignore",
    "include",
    "input",
    "inputminted",
    "item",
    "listoffigures",
    "listoftables",
    "lowertitleback",
    "lstinputlisting",
    "makeglossary",
    "makeindex",
    "maketitle",
    "markboth",
    "markleft",
    "markright",
    "minisec",
    "newpage",
    "newtheorem",
    "newtoggle",
    "opening",
    "pagebreak",
    "par",
    "paragraph",
    "parbox",
    "part",
    "pdfannot",
    "pdfstringdef",
    "pfbreak",
    "plainbreak",
    "plainfancybreak",
    "publishers",
    "raggedright",
    "rule",
    "section",
    "setdefaultlanguage",
    "setmainlanguage",
    "signature",
    "special",
    "strut",
    "subfile",
    "subject",
    "subparagraph",
    "subsection",
    "subsubsection",
    "subtitle",
    "textcolor",
    "theoremstyle",
    "title",
    "titleformat",
    "titlehead",
    "togglefalse",
    "toggletrue",
    "uppertitleback",
    "usepackage",
    "vspace",
    "write",
]);
const NEW_COMMAND_DEFINITIONS = new Set([
    "newcommand",
    "renewcommand",
    "providecommand",
    "DeclareMathOperator",
    "DeclareRobustCommand",
]);
const NEW_ENVIRONMENT_DEFINITIONS = new Set([
    "newenvironment",
    "renewenvironment",
    "provideenvironment",
]);
const DEF_COMMANDS = new Set(["def", "gdef", "edef", "xdef"]);
const RAW_DEFINITION_COMMANDS = new Set([
    ...NEW_COMMAND_DEFINITIONS,
    ...NEW_ENVIRONMENT_DEFINITIONS,
    ...DEF_COMMANDS,
    "let",
    "newif",
    "global",
]);
function latexEnvironmentAtStart(text) {
    var _a;
    const match = ENVIRONMENT_OPEN_RE.exec(text);
    return (_a = match === null || match === void 0 ? void 0 : match[1]) !== null && _a !== void 0 ? _a : null;
}
function rawLatexEnvironmentAtStart(text) {
    const environment = latexEnvironmentAtStart(text);
    return environment === null || PANDOC_INLINE_ENVIRONMENTS.has(environment)
        ? null
        : environment;
}
function rawLatexBlockStartsAt(text) {
    if (rawLatexEnvironmentAtStart(text) !== null) {
        return true;
    }
    const command = CONTROL_SEQUENCE_RE.exec(text);
    return (command !== null &&
        (PANDOC_BLOCK_COMMANDS.has(command[1]) || RAW_DEFINITION_COMMANDS.has(command[1])));
}
function skipHorizontalSpace$1(text, from) {
    let cursor = from;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
        cursor++;
    }
    return cursor;
}
function skipWhitespace(text, from) {
    let cursor = from;
    while (cursor < text.length && /\s/u.test(text[cursor])) {
        cursor++;
    }
    return cursor;
}
function escapedAt(text, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
        count++;
    }
    return count % 2 === 1;
}
function balancedGroupEnd(text, from, open, close) {
    if (text[from] !== open) {
        return null;
    }
    let depth = 0;
    let inComment = false;
    for (let cursor = from; cursor < text.length; cursor++) {
        const char = text[cursor];
        if (inComment) {
            if (char === "\n") {
                inComment = false;
            }
            continue;
        }
        if (char === "%" && !escapedAt(text, cursor)) {
            inComment = true;
            continue;
        }
        if (char === open && !escapedAt(text, cursor)) {
            depth++;
        }
        if (char === close && !escapedAt(text, cursor)) {
            depth--;
            if (depth === 0) {
                return cursor + 1;
            }
        }
    }
    return null;
}
function controlSequenceEnd(text, from) {
    if (text[from] !== "\\") {
        return null;
    }
    const match = /^\\(?:[A-Za-z@]+|.)/u.exec(text.slice(from));
    return match === null ? null : from + match[0].length;
}
function genericBlockCommandEnd(text, initialEnd) {
    let cursor = initialEnd;
    let end = initialEnd;
    while (true) {
        const argumentStart = skipWhitespace(text, cursor);
        const char = text[argumentStart];
        if (char !== "[" && char !== "{") {
            break;
        }
        const argumentEnd = balancedGroupEnd(text, argumentStart, char, char === "[" ? "]" : "}");
        if (argumentEnd === null) {
            break;
        }
        cursor = argumentEnd;
        end = argumentEnd;
    }
    return end;
}
function newCommandDefinitionEnd(text, initialEnd) {
    let cursor = skipWhitespace(text, initialEnd);
    if (text[cursor] === "*") {
        cursor = skipWhitespace(text, cursor + 1);
    }
    if (text[cursor] === "{") {
        const end = balancedGroupEnd(text, cursor, "{", "}");
        if (end === null) {
            return null;
        }
        cursor = end;
    }
    else {
        const end = controlSequenceEnd(text, cursor);
        if (end === null) {
            return null;
        }
        cursor = end;
    }
    cursor = skipWhitespace(text, cursor);
    for (let optional = 0; optional < 2 && text[cursor] === "["; optional++) {
        const end = balancedGroupEnd(text, cursor, "[", "]");
        if (end === null) {
            return null;
        }
        cursor = skipWhitespace(text, end);
    }
    if (text[cursor] === "{") {
        return balancedGroupEnd(text, cursor, "{", "}");
    }
    return controlSequenceEnd(text, cursor);
}
function newEnvironmentDefinitionEnd(text, initialEnd) {
    let cursor = skipWhitespace(text, initialEnd);
    if (text[cursor] === "*") {
        cursor = skipWhitespace(text, cursor + 1);
    }
    const nameEnd = balancedGroupEnd(text, cursor, "{", "}");
    if (nameEnd === null) {
        return null;
    }
    cursor = skipWhitespace(text, nameEnd);
    for (let optional = 0; optional < 2 && text[cursor] === "["; optional++) {
        const end = balancedGroupEnd(text, cursor, "[", "]");
        if (end === null) {
            return null;
        }
        cursor = skipWhitespace(text, end);
    }
    for (let body = 0; body < 2; body++) {
        const end = balancedGroupEnd(text, cursor, "{", "}");
        if (end === null) {
            return null;
        }
        cursor = skipWhitespace(text, end);
    }
    return cursor;
}
function defCommandEnd(text, initialEnd) {
    let cursor = skipHorizontalSpace$1(text, initialEnd);
    const nameEnd = controlSequenceEnd(text, cursor);
    if (nameEnd === null) {
        return null;
    }
    cursor = nameEnd;
    while (cursor < text.length) {
        if (text[cursor] === "{") {
            return balancedGroupEnd(text, cursor, "{", "}");
        }
        if (text[cursor] === "\n") {
            return null;
        }
        cursor++;
    }
    return null;
}
function lineEnd(text, from) {
    const newline = text.indexOf("\n", from);
    const end = newline === -1 ? text.length : newline;
    let trimmed = end;
    while (trimmed > from && (text[trimmed - 1] === " " || text[trimmed - 1] === "\t")) {
        trimmed--;
    }
    return trimmed;
}
function rawLatexCommandEndAtStart(text) {
    const match = CONTROL_SEQUENCE_RE.exec(text);
    if (match === null) {
        return null;
    }
    const name = match[1];
    const initialEnd = match[0].length;
    if (name === "global") {
        const nestedStart = skipWhitespace(text, initialEnd);
        const nestedEnd = rawLatexCommandEndAtStart(text.slice(nestedStart));
        return nestedEnd === null ? null : nestedStart + nestedEnd;
    }
    if (NEW_COMMAND_DEFINITIONS.has(name)) {
        return newCommandDefinitionEnd(text, initialEnd);
    }
    if (NEW_ENVIRONMENT_DEFINITIONS.has(name)) {
        return newEnvironmentDefinitionEnd(text, initialEnd);
    }
    if (DEF_COMMANDS.has(name)) {
        return defCommandEnd(text, initialEnd);
    }
    if (name === "let" || name === "newif") {
        return lineEnd(text, initialEnd);
    }
    if (!PANDOC_BLOCK_COMMANDS.has(name)) {
        return null;
    }
    return genericBlockCommandEnd(text, initialEnd);
}
function escapedPercent(text, index) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}
function withoutLatexComment(line) {
    for (let index = 0; index < line.length; index++) {
        if (line[index] === "%" && !escapedPercent(line, index)) {
            return line.slice(0, index);
        }
    }
    return line;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Return the offset immediately after the balanced closing environment.
 * `text` must start at the authored `\\begin{...}`. Newlines and arbitrary
 * blank lines are allowed. Same-name nesting is balanced, and TeX comments do
 * not contribute fake open/close tokens.
 */
function rawLatexEnvironmentEnd(text, environment) {
    if (latexEnvironmentAtStart(text) !== environment) {
        return null;
    }
    const escaped = escapeRegExp(environment);
    const tokenRe = new RegExp(`\\\\(?:begin|end)\\{${escaped}\\}`, "gu");
    let depth = 0;
    let lineFrom = 0;
    while (lineFrom <= text.length) {
        const newline = text.indexOf("\n", lineFrom);
        const lineTo = newline === -1 ? text.length : newline;
        const line = withoutLatexComment(text.slice(lineFrom, lineTo));
        tokenRe.lastIndex = 0;
        for (let match = tokenRe.exec(line); match !== null; match = tokenRe.exec(line)) {
            if (match[0].startsWith("\\begin")) {
                depth++;
            }
            else {
                depth--;
                if (depth === 0) {
                    return lineFrom + match.index + match[0].length;
                }
            }
        }
        if (newline === -1) {
            break;
        }
        lineFrom = newline + 1;
    }
    return null;
}
/**
 * End offset for the subset of Pandoc RawInline(tex) syntax that begins with a
 * control sequence or one of Pandoc's LaTeX inline environments.
 *
 * Reference implementation: Pandoc 3.10.2 `rawLaTeXInline` in
 * Text/Pandoc/Readers/LaTeX.hs (lines 196-207), using `inline` and
 * `inlineEnvironment`. The executable Pandoc JSON reader is the differential
 * oracle for the admitted shapes.
 */
function rawLatexInlineEndAtStart(text) {
    const environment = latexEnvironmentAtStart(text);
    if (environment !== null) {
        if (!PANDOC_INLINE_ENVIRONMENTS.has(environment)) {
            return null;
        }
        return rawLatexEnvironmentEnd(text, environment);
    }
    const command = CONTROL_SEQUENCE_RE.exec(text);
    if (command === null) {
        return null;
    }
    let cursor = command[0].length;
    let consumedArgument = false;
    while (cursor < text.length) {
        const beforeSpace = cursor;
        cursor = skipHorizontalSpace$1(text, cursor);
        const opener = text[cursor];
        if (opener !== "[" && opener !== "{") {
            // TeX control WORDS absorb following horizontal space when they carry no
            // argument. Pandoc preserves that absorbed space in RawInline(tex).
            // Once an argument has been consumed, subsequent space is Markdown.
            if (consumedArgument) {
                cursor = beforeSpace;
            }
            break;
        }
        const end = balancedGroupEnd(text, cursor, opener, opener === "[" ? "]" : "}");
        if (end === null) {
            return null;
        }
        consumedArgument = true;
        cursor = end;
    }
    // A control sequence itself is valid raw inline even without arguments
    // (e.g. \LaTeX); arguments are consumed when present.
    return consumedArgument || cursor > 1 ? cursor : null;
}
/** Exact end of one editor-supported Pandoc RawBlock(tex) source unit. */
function rawLatexBlockEndAtStart(text) {
    const environment = rawLatexEnvironmentAtStart(text);
    if (environment !== null) {
        return rawLatexEnvironmentEnd(text, environment);
    }
    return rawLatexCommandEndAtStart(text);
}
/**
 * Reconstruct the semantic raw-block source from parser-owned content ranges.
 * Container syntax such as `> ` or list indentation lives in the gaps between
 * these ranges and is therefore omitted, matching Pandoc's RawBlock payload.
 */
function rawBlockSourceFromNode(node, read) {
    const content = node.getChildren("RawBlockContent");
    if (content.length === 0) {
        return read(node.from, node.to);
    }
    return content.map((range) => read(range.from, range.to)).join("");
}
function rawBlockLineRangesFromNode(node, read) {
    const content = node.getChildren("RawBlockContent");
    if (content.length === 0) {
        return [{ from: node.from, to: node.to }];
    }
    return content.map((range) => ({
        from: range.from,
        to: range.to > range.from && read(range.to - 1, range.to) === "\n" ? range.to - 1 : range.to,
    }));
}

/**
 * Pandoc raw-TeX block grammar. Reference implementation: Pandoc 3.10.2
 * commit f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/LaTeX.hs `rawLaTeXBlock` (line 153).
 */
/** Pandoc-compatible block parser for raw non-math LaTeX environments. */
function isLezerInput(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    return (typeof Reflect.get(value, "read") === "function" &&
        typeof Reflect.get(value, "length") === "number");
}
function blockInput(ctx) {
    const input = Reflect.get(ctx, "input");
    if (!isLezerInput(input)) {
        throw new Error("raw-latex-block parser requires Lezer BlockContext.input");
    }
    return input;
}
const rawLatexBlockParser = {
    name: "raw-latex-block",
    before: "HTMLBlock",
    endLeaf: (_ctx, line) => rawLatexBlockStartsAt(line.text.slice(line.pos)),
    parse: (ctx, line) => {
        if (!rawLatexBlockStartsAt(line.text.slice(line.pos))) {
            return false;
        }
        const absoluteStart = ctx.parsedPos + line.pos;
        const remaining = blockInput(ctx).read(absoluteStart, blockInput(ctx).length);
        const relativeEnd = rawLatexBlockEndAtStart(remaining);
        if (relativeEnd === null) {
            return false;
        }
        const absoluteEnd = absoluteStart + relativeEnd;
        const blockStart = ctx.lineStart + line.pos;
        const content = [];
        let firstLine = true;
        // Advance only after a complete closing environment is known to exist.
        // This keeps an unterminated environment ordinary editable source rather
        // than consuming the rest of the document speculatively.
        while (absoluteEnd > ctx.parsedPos + line.text.length) {
            const contentFrom = ctx.lineStart + (firstLine ? line.pos : line.basePos);
            const contentTo = ctx.lineStart + line.text.length + 1;
            content.push(ctx.elt("RawBlockContent", contentFrom, contentTo));
            firstLine = false;
            if (!ctx.nextLine()) {
                return false;
            }
        }
        const closePos = absoluteEnd - ctx.parsedPos;
        const blockEnd = ctx.lineStart + closePos;
        const finalFrom = ctx.lineStart + (firstLine ? line.pos : line.basePos);
        content.push(ctx.elt("RawBlockContent", finalFrom, blockEnd));
        ctx.addElement(ctx.elt("RawBlock", blockStart, blockEnd, content));
        // Pandoc permits ordinary Markdown after the closing environment on the
        // same physical line. Leave that suffix for the normal block parser.
        if (line.text.slice(closePos).trim() !== "") {
            line.moveBase(closePos);
            return null;
        }
        ctx.nextLine();
        return true;
    },
};
/**
 * Pandoc RawInline(tex) adapter. Math delimiters run before this parser; raw
 * TeX runs before CommonMark's Escape parser, matching Markdown.hs where
 * `math <|> escaped... <|> rawLaTeXInline'` decides a backslash-led inline.
 */
const rawLatexInlineParser = {
    name: "raw-latex-inline",
    before: "Escape",
    parse: (ctx, next, pos) => {
        if (next !== 92) { // backslash
            return -1;
        }
        const localFrom = pos - ctx.offset;
        const relativeEnd = rawLatexInlineEndAtStart(ctx.text.slice(localFrom));
        if (relativeEnd === null) {
            return -1;
        }
        const to = pos + relativeEnd;
        return ctx.addElement(ctx.elt("RawInline", pos, to, [
            ctx.elt("RawInlineContent", pos, to),
        ]));
    },
};

/**
 * Pandoc pipe/grid table grammar.
 *
 * Reference implementation: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `gridTable` (line 1407), `pipeBreak`
 * (line 1426), `pipeTable` (line 1436), `pipeTableRow` (line 1467),
 * `pipeTableCell` (line 1483), `pipeTableHeaderPart` (line 1489), and
 * `scanForPipe`. Grid-table geometry ultimately delegates there to
 * Text/Pandoc/Parsing.hs `gridTableWith'`.
 *
 * Recognition tests in test/pandoc-table-differential-oracle.spec.ts use the
 * real Pandoc JSON reader as the semantic oracle.
 */
function skipHorizontalSpace(text, from = 0) {
    let cursor = from;
    while (text[cursor] === ' ' || text[cursor] === '\t')
        cursor++;
    return cursor;
}
function previousNonspace(text) {
    let cursor = text.length - 1;
    while (cursor >= 0 && (text[cursor] === ' ' || text[cursor] === '\t'))
        cursor--;
    return cursor;
}
function codeSpanEnd(text, from) {
    if (text[from] !== '`')
        return from;
    let width = 1;
    while (text[from + width] === '`')
        width++;
    const mark = '`'.repeat(width);
    const end = text.indexOf(mark, from + width);
    return end < 0 ? from : end + width;
}
function delimitedMathEnd(text, from) {
    let close;
    let contentFrom = from;
    if (text.startsWith('$$', from)) {
        close = '$$';
        contentFrom += 2;
    }
    else if (text[from] === '$') {
        close = '$';
        contentFrom++;
    }
    else if (text.startsWith('\\(', from)) {
        close = '\\)';
        contentFrom += 2;
    }
    else if (text.startsWith('\\[', from)) {
        close = '\\]';
        contentFrom += 2;
    }
    if (close === undefined)
        return from;
    for (let cursor = contentFrom; cursor < text.length; cursor++) {
        if (text.startsWith(close, cursor))
            return cursor + close.length;
        if (text[cursor] === '\\' && !text.startsWith('\\)', cursor) && !text.startsWith('\\]', cursor))
            cursor++;
    }
    return from;
}
function htmlInlineEnd(text, from) {
    if (text[from] !== '<')
        return from;
    let quote;
    for (let cursor = from + 1; cursor < text.length; cursor++) {
        const char = text[cursor];
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '>')
            return cursor + 1;
    }
    return from;
}
/**
 * Find separator pipes while honoring exactly the classes of chunks Pandoc's
 * `pipeTableRow` protects from separator interpretation: code, math, raw HTML,
 * escaped characters, and raw LaTeX inline syntax.
 */
function pipeSeparators(line) {
    const result = [];
    for (let cursor = 0; cursor < line.length; cursor++) {
        const char = line[cursor];
        if (char === '\\') {
            const mathEnd = delimitedMathEnd(line, cursor);
            if (mathEnd > cursor) {
                cursor = mathEnd - 1;
                continue;
            }
            const rawEnd = rawLatexInlineEndAtStart(line.slice(cursor));
            if (rawEnd !== null) {
                cursor += rawEnd - 1;
                continue;
            }
            if (cursor + 1 < line.length)
                cursor++;
            continue;
        }
        if (char === '`') {
            const end = codeSpanEnd(line, cursor);
            if (end > cursor) {
                cursor = end - 1;
                continue;
            }
        }
        if (char === '$') {
            const end = delimitedMathEnd(line, cursor);
            if (end > cursor) {
                cursor = end - 1;
                continue;
            }
        }
        if (char === '<') {
            const end = htmlInlineEnd(line, cursor);
            if (end > cursor) {
                cursor = end - 1;
                continue;
            }
        }
        if (char === '|')
            result.push(cursor);
    }
    return result;
}
/** Port of Pandoc `pipeTableRow`: split a physical row only at real pipe separators. */
function scanPipeRow(line) {
    const separators = pipeSeparators(line);
    if (separators.length === 0)
        return null;
    const contentStart = skipHorizontalSpace(line);
    const contentEnd = previousNonspace(line);
    const leadingPipe = separators[0] === contentStart;
    const trailingPipe = separators[separators.length - 1] === contentEnd;
    const cells = [];
    let from = leadingPipe ? separators[0] + 1 : contentStart;
    const firstSeparator = leadingPipe ? 1 : 0;
    for (let index = firstSeparator; index < separators.length; index++) {
        cells.push({ from, to: separators[index] });
        from = separators[index] + 1;
    }
    if (!trailingPipe)
        cells.push({ from, to: line.length });
    // Pandoc admits a one-column row only when an outer pipe makes it
    // unambiguously tabular.
    if (cells.length === 1 && !leadingPipe && !trailingPipe)
        return null;
    return { cells, separators, leadingPipe, trailingPipe };
}
/** Port of Pandoc `pipeBreak` + `pipeTableHeaderPart`. */
function scanPipeDelimiter(line) {
    let source = line.trim();
    const leadingPipe = source.startsWith('|');
    const trailingPipe = source.endsWith('|');
    if (leadingPipe)
        source = source.slice(1);
    if (trailingPipe)
        source = source.slice(0, -1);
    if (source.trim() === '')
        return null;
    const parts = source.split(/[|+]/u);
    if (parts.some(part => !/^\s*:?-+:?\s*$/u.test(part)))
        return null;
    if (parts.length === 1 && !leadingPipe && !trailingPipe)
        return null;
    return { columns: parts.length };
}
function trimmedSpan(line, span) {
    let from = span.from;
    let to = span.to;
    while (from < to && (line[from] === ' ' || line[from] === '\t'))
        from++;
    while (to > from && (line[to - 1] === ' ' || line[to - 1] === '\t'))
        to--;
    return { from, to };
}
function pipeRowElement(ctx, name, line, absoluteStart) {
    const scanned = scanPipeRow(line);
    if (scanned === null)
        return null;
    const elements = [];
    for (const separator of scanned.separators) {
        elements.push(ctx.elt('TableDelimiter', absoluteStart + separator, absoluteStart + separator + 1));
    }
    for (const rawCell of scanned.cells) {
        const cell = trimmedSpan(line, rawCell);
        if (cell.from === cell.to)
            continue;
        elements.push(ctx.elt('TableCell', absoluteStart + cell.from, absoluteStart + cell.to, ctx.parser.parseInline(line.slice(cell.from, cell.to), absoluteStart + cell.from)));
    }
    elements.sort((a, b) => a.from - b.from || a.to - b.to);
    return ctx.elt(name, absoluteStart, absoluteStart + line.length, elements);
}
class PandocPipeTableParser {
    constructor() {
        this.rows = null;
        this.columns = 0;
    }
    addTable(ctx, leaf) {
        if (this.rows === false || this.rows === null)
            return false;
        ctx.addLeafElement(leaf, ctx.elt('Table', leaf.start, leaf.start + leaf.content.length, this.rows));
        this.rows = false;
        return true;
    }
    nextLine(ctx, line, leaf) {
        const text = line.text.slice(line.pos);
        const absoluteStart = ctx.lineStart + line.pos;
        if (this.rows === null) {
            const delimiter = scanPipeDelimiter(text);
            const header = pipeRowElement(ctx, 'TableHeader', leaf.content, leaf.start);
            if (delimiter === null || header === null) {
                this.rows = false;
                return false;
            }
            this.columns = delimiter.columns;
            this.rows = [
                header,
                ctx.elt('TableDelimiter', absoluteStart, absoluteStart + text.length),
            ];
            return false;
        }
        if (this.rows === false)
            return false;
        const row = pipeRowElement(ctx, 'TableRow', text, absoluteStart);
        if (row === null) {
            // Pandoc's `many pipeTableRow` stops before the first non-row. Finish the
            // table without consuming this line so normal block parsing sees it.
            this.addTable(ctx, leaf);
            return true;
        }
        this.rows.push(row);
        return false;
    }
    finish(ctx, leaf) {
        return this.addTable(ctx, leaf);
    }
}
const pipeTableParser = {
    name: 'pipe-table',
    before: 'SetextHeading',
    leaf(_ctx, leaf) {
        return scanPipeRow(leaf.content) === null ? null : new PandocPipeTableParser();
    },
    endLeaf(ctx, line, leaf) {
        if (leaf.parsers.some(parser => parser instanceof PandocPipeTableParser))
            return false;
        const current = line.text.slice(line.basePos);
        if (scanPipeRow(current) === null)
            return false;
        return scanPipeDelimiter(ctx.peekLine()) !== null;
    },
};
// Grid tables use fixed column boundaries rather than inline pipe splitting.
// The Lezer tree preserves physical row/cell spans for the editor; Pandoc's
// JSON oracle verifies recognition, header-vs-body classification, and column
// count for the supported geometry.
const GRID_BORDER = /^\s*\+(?:(?:-+|=+)\+)+\s*$/u;
const GRID_CONTENT = /^\s*\|.*\|\s*$/u;
function gridBoundaries(line) {
    const result = [];
    for (let index = 0; index < line.length; index++) {
        if (line[index] === '+')
            result.push(index);
    }
    return result;
}
function sameGridGeometry(line, boundaries) {
    const positions = [];
    for (let index = 0; index < line.length; index++) {
        if (line[index] === '+' || line[index] === '|')
            positions.push(index);
    }
    return positions.length === boundaries.length && positions.every((value, index) => value === boundaries[index]);
}
function gridCells(ctx, line, absoluteStart, boundaries) {
    const result = [];
    for (let column = 0; column + 1 < boundaries.length; column++) {
        const raw = { from: boundaries[column] + 1, to: boundaries[column + 1] };
        const cell = trimmedSpan(line, raw);
        if (cell.from === cell.to)
            continue;
        result.push(ctx.elt('TableCell', absoluteStart + cell.from, absoluteStart + cell.to, ctx.parser.parseInline(line.slice(cell.from, cell.to), absoluteStart + cell.from)));
    }
    for (const boundary of boundaries) {
        result.push(ctx.elt('TableDelimiter', absoluteStart + boundary, absoluteStart + boundary + 1));
    }
    result.sort((a, b) => a.from - b.from || a.to - b.to);
    return result;
}
const gridTableParser = {
    name: 'grid-table',
    parse: (ctx, line) => {
        const opening = line.text.slice(line.pos);
        if (!GRID_BORDER.test(opening) || opening.includes('='))
            return false;
        const boundaries = gridBoundaries(opening);
        if (boundaries.length < 2)
            return false;
        const start = ctx.lineStart + line.pos;
        const children = [ctx.elt('TableDelimiter', start, start + opening.length)];
        let rowStart = -1;
        let rowLines = [];
        let headerClosed = false;
        let lastEnd = start + opening.length;
        let closed = false;
        const flushRow = (asHeader) => {
            if (rowStart < 0 || rowLines.length === 0)
                return;
            const rowChildren = [];
            // A physical line for each cell line. Multi-line grid cells remain within
            // one logical TableHeader/TableRow container; the AST adapter can join
            // their child nodes without fabricating extra rows.
            for (const physical of rowLines) {
                rowChildren.push(...gridCells(ctx, physical.text, physical.start, boundaries));
            }
            const rowEnd = rowLines[rowLines.length - 1].start + rowLines[rowLines.length - 1].text.length;
            children.push(ctx.elt(asHeader ? 'TableHeader' : 'TableRow', rowStart, rowEnd, rowChildren));
            rowStart = -1;
            rowLines = [];
        };
        while (ctx.nextLine()) {
            const text = line.text.slice(line.pos);
            const absolute = ctx.lineStart + line.pos;
            if (GRID_CONTENT.test(text) && sameGridGeometry(text, boundaries)) {
                if (rowStart < 0)
                    rowStart = absolute;
                rowLines.push({ text, start: absolute });
                lastEnd = absolute + text.length;
                continue;
            }
            if (!GRID_BORDER.test(text) || !sameGridGeometry(text, boundaries)) {
                return false;
            }
            const headerSeparator = text.includes('=');
            flushRow(headerSeparator && !headerClosed);
            if (headerSeparator)
                headerClosed = true;
            children.push(ctx.elt('TableDelimiter', absolute, absolute + text.length));
            lastEnd = absolute + text.length;
            // A border with no following grid-content line closes the table. Peek is
            // sufficient here: gridTableWith' likewise stops at the completed border.
            const next = ctx.peekLine();
            if (!GRID_CONTENT.test(next)) {
                closed = true;
                ctx.nextLine();
                break;
            }
        }
        if (!closed || rowStart >= 0)
            return false;
        ctx.addElement(ctx.elt('Table', start, lastEnd, children));
        return true;
    },
};

/**
 * Pandoc reference: Pandoc 3.10.2 commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918,
 * src/Text/Pandoc/Readers/Markdown.hs `wikilink` (line 1887), with
 * Ext_wikilinks_title_after_pipe / Ext_wikilinks_title_before_pipe.
 */
const ZknLinkDelimiter = {};
// This parser adds Zettelkasten links to the syntax tree.
const zknLinkParser = function (config) {
    return {
        // This parser should only match zettelkasten-style links
        name: 'zkn-links',
        before: 'Link', // In case of default [[links]], the inner brackets would be detected as links
        parse: (ctx, next, pos) => {
            if (next === 91 && ctx.char(pos + 1) === 91) { // 91 === '['
                ctx.addDelimiter(ZknLinkDelimiter, pos, pos + 2, true, false);
                // Return -1 so the default link parser can add its delimiters
                return -1;
            }
            let opening = null;
            if (next === 93 && ctx.char(pos + 1) === 93) { // 93 === ']'
                opening = ctx.findOpeningDelimiter(ZknLinkDelimiter);
            }
            if (opening === null) {
                return -1;
            }
            const delim = ctx.getDelimiterAt(opening);
            if (delim === null) {
                return -1;
            }
            // Remove any elements that were parsed internally
            ctx.takeContent(opening);
            ctx.addDelimiter(ZknLinkDelimiter, pos, pos + 2, false, true);
            const contents = ctx.slice(delim.to, pos);
            const pipeIdx = contents.indexOf('|');
            // Pandoc's `wikilink` only rejects control whitespace in the URL side of
            // the construct. With `wikilinks_title_after_pipe`, that is the text
            // before the first pipe; with the inverse dialect it is the text after.
            // Reference: Markdown.hs `wikilink`, guard on `url` immediately before
            // constructing the Link/Image.
            const titleFirst = (config === null || config === void 0 ? void 0 : config.format) === 'title|link';
            const target = pipeIdx < 0
                ? contents
                : titleFirst ? contents.slice(pipeIdx + 1) : contents.slice(0, pipeIdx);
            if (/\n|\r|\f|\t/u.test(target)) {
                return -1;
            }
            const children = [];
            // NOTE: In order to avoid either empty links or empty titles and having
            // to deal with these edge cases, we disallow putting pipes at either the
            // beginning or the end of a link.
            if (pipeIdx > 0 && pipeIdx < contents.length) {
                // The link contains both a link and a title.
                children.push(ctx.elt(titleFirst ? 'ZknLinkTitle' : 'ZknLinkContent', delim.to, delim.to + pipeIdx), ctx.elt('ZknLinkPipe', delim.to + pipeIdx, delim.to + pipeIdx + 1), ctx.elt(titleFirst ? 'ZknLinkContent' : 'ZknLinkTitle', delim.to + pipeIdx + 1, pos));
            }
            else {
                // The link equals the title, no pipe found
                children.push(ctx.elt('ZknLinkContent', delim.to, pos));
            }
            const openingMark = ctx.elt('ZknLinkMark', delim.from, delim.to);
            const closingMark = ctx.elt('ZknLinkMark', pos, pos + 2);
            return ctx.addElement(ctx.elt('ZknLink', delim.from, pos + 2, [openingMark, ...children, closingMark]));
        }
    };
};

/**
 * Pandoc Markdown extensions owned by this @lezer/markdown fork.
 *
 * The grammar is not specified from Zettlr examples. Every rule in this
 * directory names the Pandoc 3.10.2 implementation it ports, pinned at commit
 * f2ee5dfee866aab007a33552acc6bc01810c6918. Differential tests additionally
 * invoke the real `pandoc` reader as an executable oracle.
 */
const pandocNodes = {
    defineNodes: [
        { name: 'YAMLFrontmatter', block: true },
        'YAMLFrontmatterStart',
        'YAMLFrontmatterEnd',
        'Citation',
        'CitationMark',
        'CitationPrefix',
        'CitationSuppressAuthorFlag',
        'CitationAtSign',
        'CitationCitekey',
        'CitationLocator',
        'CitationSuffix',
        'Footnote',
        {
            name: 'FootnoteRef',
            block: true,
            composite: footnoteComposite,
        },
        'FootnoteRefLabel',
        'ZknLink',
        'ZknLinkMark',
        'ZknLinkContent',
        'ZknLinkTitle',
        'ZknLinkPipe',
        'PandocAttribute',
        'PandocAttributeMark',
        {
            name: 'PandocDiv',
            block: true,
            composite: pandocDivComposite,
        },
        'PandocDivInfo',
        'PandocDivMark',
        'PandocSpan',
        'PandocSpanMark',
        { name: 'RawBlock', block: true },
        'RawBlockContent',
        'RawInline',
        'RawInlineContent',
        { name: 'Table', block: true },
        'TableHeader',
        'TableRow',
        'TableCell',
        'TableDelimiter',
    ],
};
/**
 * Return the Pandoc-flavored Markdown grammar used by the editor.
 *
 * The four reused Lezer extension implementations correspond to Pandoc's
 * default Ext_strikeout, Ext_superscript, Ext_subscript, and Ext_task_lists.
 * Pandoc reference: Markdown.hs `strikeout` (1749), `superscript` (1763),
 * `subscript` (1776), and list-item task conversion around line 981 at the
 * pinned reference commit above. Their acceptance belongs to the same Pandoc
 * differential corpus as the fork-owned parsers.
 */
function PandocSyntax(options = {}) {
    return [
        pandocNodes,
        {
            parseBlock: [
                pandocDivParser,
                rawLatexBlockParser,
                frontmatterParser,
                blockMathParser,
                footnoteRefParser,
                gridTableParser,
                pipeTableParser,
            ],
            parseInline: [
                pandocSpanParser,
                inlineMathParser,
                singleBackslashMathParser,
                rawLatexInlineParser,
                footnoteParser,
                citationParser,
                zknLinkParser({ format: options.wikilinks }),
                pandocLinkParser,
                pandocAttributesParser,
            ],
        },
    ];
}

function leftOverSpace(node, from, to) {
    let ranges = [];
    for (let n = node.firstChild, pos = from;; n = n.nextSibling) {
        let nextPos = n ? n.from : to;
        if (nextPos > pos)
            ranges.push({ from: pos, to: nextPos });
        if (!n)
            break;
        pos = n.to;
    }
    return ranges;
}
/**
Create a Markdown extension to enable nested parsing on code
blocks and/or embedded HTML.
*/
function parseCode(config) {
    let { codeParser, htmlParser } = config;
    let wrap = common.parseMixed((node, input) => {
        let id = node.type.id;
        if (codeParser && (id == Type.CodeBlock || id == Type.FencedCode)) {
            let info = "";
            if (id == Type.FencedCode) {
                let infoNode = node.node.getChild(Type.CodeInfo);
                if (infoNode)
                    info = input.read(infoNode.from, infoNode.to);
            }
            let parser = codeParser(info);
            if (parser)
                return { parser, overlay: node => node.type.id == Type.CodeText, bracketed: id == Type.FencedCode };
        }
        else if (htmlParser && (id == Type.HTMLBlock || id == Type.HTMLTag || id == Type.CommentBlock)) {
            return { parser: htmlParser, overlay: leftOverSpace(node.node, node.from, node.to) };
        }
        return null;
    });
    return { wrap };
}

/**
 * Complete Pandoc-flavored Markdown extension supported by this fork.
 * The reused Lezer extensions correspond to Pandoc's default strikeout,
 * superscript, subscript, and task-list extensions; all remaining syntax is
 * owned by `PandocSyntax` in the fork.
 */
function Pandoc(options = {}) {
    return [Strikethrough, Superscript, Subscript, TaskList, PandocSyntax(options)];
}
function createPandocParser(options = {}) {
    return parser.configure(Pandoc(options));
}

exports.Autolink = Autolink;
exports.BlockContext = BlockContext;
exports.CITATION_NODES = NODES;
exports.Element = Element;
exports.Emoji = Emoji;
exports.GFM = GFM;
exports.InlineContext = InlineContext;
exports.LeafBlock = LeafBlock;
exports.Line = Line;
exports.MarkdownParser = MarkdownParser;
exports.Pandoc = Pandoc;
exports.Strikethrough = Strikethrough;
exports.Subscript = Subscript;
exports.Superscript = Superscript;
exports.Table = Table;
exports.TaskList = TaskList;
exports.citationParser = citationParser;
exports.createPandocParser = createPandocParser;
exports.parseCitationLocator = parseCitationLocator;
exports.parseCitationSuffix = parseCitationSuffix;
exports.parseCode = parseCode;
exports.parser = parser;
exports.rawBlockLineRangesFromNode = rawBlockLineRangesFromNode;
exports.rawBlockSourceFromNode = rawBlockSourceFromNode;
exports.rawLatexBlockEndAtStart = rawLatexBlockEndAtStart;
exports.rawLatexBlockStartsAt = rawLatexBlockStartsAt;
exports.rawLatexEnvironmentAtStart = rawLatexEnvironmentAtStart;
exports.rawLatexEnvironmentEnd = rawLatexEnvironmentEnd;
exports.rawLatexInlineEndAtStart = rawLatexInlineEndAtStart;
exports.scanPandocAttributeList = scanPandocAttributeList;
exports.scanPandocFencedDivOpening = scanPandocFencedDivOpening;
