// =============================================================================
//  html2json.js
//  Converts an HTML string into a structured JSON object.
//
//  Architecture: Finite-State Machine (FSM) Tokenizer → Tree Builder
//  ─────────────────────────────────────────────────────────────────
//  Instead of one giant regex, parsing is split into two clean phases:
//
//  Phase 1 – Tokenize  (tokenize)
//    Walks the raw HTML character-by-character through a set of named states.
//    Each state decides what the current character means and may transition to
//    a different state.  The output is a flat array of typed tokens:
//      { type: 'doctype' | 'comment' | 'open' | 'close' | 'self-close' | 'text',
//        tagName?, attributes?, content? }
//
//  Phase 2 – Build Tree  (buildTree)
//    Iterates the token array and maintains a stack.  Opening tags push a new
//    node; closing tags (and implicit closes from void elements) pop the stack;
//    text/comment tokens are appended as leaf nodes.  Unclosed tags are
//    implicitly closed when the input runs out.
// =============================================================================

"use strict";

// ---------------------------------------------------------------------------
// 1. CONSTANTS
// ---------------------------------------------------------------------------

/**
 * HTML void (self-closing) elements per the HTML5 spec.
 * These never have closing tags and must not push onto the stack.
 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// FSM states used by the tokenizer
const STATE = Object.freeze({
  TEXT:              "TEXT",
  TAG_OPEN:          "TAG_OPEN",           // saw '<'
  CLOSE_TAG:         "CLOSE_TAG",          // saw '</'
  TAG_NAME:          "TAG_NAME",           // reading tag name
  CLOSE_TAG_NAME:    "CLOSE_TAG_NAME",     // reading closing tag name
  BEFORE_ATTR:       "BEFORE_ATTR",        // whitespace between attrs
  ATTR_NAME:         "ATTR_NAME",          // reading attr name
  AFTER_ATTR_NAME:   "AFTER_ATTR_NAME",    // saw attr name, may see '='
  ATTR_VALUE_START:  "ATTR_VALUE_START",   // saw '=', deciding quote style
  ATTR_VALUE_DQ:     "ATTR_VALUE_DQ",      // inside "..."
  ATTR_VALUE_SQ:     "ATTR_VALUE_SQ",      // inside '...'
  ATTR_VALUE_NQ:     "ATTR_VALUE_NQ",      // unquoted value
  COMMENT:           "COMMENT",            // inside <!-- ... -->
  COMMENT_DASH1:     "COMMENT_DASH1",      // saw first '-' of '-->'
  COMMENT_DASH2:     "COMMENT_DASH2",      // saw '--', waiting for '>'
  DOCTYPE:           "DOCTYPE",            // inside <!DOCTYPE ...>
  SELF_CLOSE:        "SELF_CLOSE",         // saw '/' at end of open tag
});

// ---------------------------------------------------------------------------
// 2. TOKENIZER  (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Tokenizes an HTML string into a flat list of token objects.
 *
 * @param {string} html - Raw HTML source.
 * @returns {Array<Object>} tokens
 */
function tokenize(html) {
  // Guard: handle non-string input gracefully
  if (typeof html !== "string") {
    html = String(html == null ? "" : html);
  }

  const tokens  = [];
  let   state   = STATE.TEXT;
  let   i       = 0;
  let   buf     = "";           // general character accumulation buffer

  // Current open-tag working variables
  let tagName   = "";
  let attrs     = {};           // { attrName: attrValue }
  let attrName  = "";
  let attrValue = "";
  let commentBuf = "";

  // ---------------------------------------------------------------------------
  // Helper: flush a non-empty text buffer as a text token
  // ---------------------------------------------------------------------------
  function flushText() {
    if (buf.length > 0) {
      tokens.push({ type: "text", content: buf });
      buf = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: commit the current attribute into the attrs map
  // ---------------------------------------------------------------------------
  function commitAttr() {
    if (attrName.length > 0) {
      // Boolean attribute if no value was ever set
      attrs[attrName.toLowerCase()] = attrValue.length > 0 ? attrValue : true;
    }
    attrName  = "";
    attrValue = "";
  }

  // ---------------------------------------------------------------------------
  // Helper: emit an open-tag token and reset working vars
  // ---------------------------------------------------------------------------
  function emitOpenTag(selfClose) {
    const lowerTag = tagName.toLowerCase();
    const isSelfClose = selfClose || VOID_ELEMENTS.has(lowerTag);
    tokens.push({
      type:       isSelfClose ? "self-close" : "open",
      tagName:    lowerTag,
      attributes: { ...attrs },
    });
    tagName = "";
    attrs   = {};
  }

  // ---------------------------------------------------------------------------
  // Main character-by-character FSM loop
  // ---------------------------------------------------------------------------
  while (i < html.length) {
    const ch = html[i];

    switch (state) {

      // ── TEXT ──────────────────────────────────────────────────────────────
      case STATE.TEXT:
        if (ch === "<") {
          flushText();
          state = STATE.TAG_OPEN;
        } else {
          buf += ch;
        }
        break;

      // ── TAG_OPEN: we've just seen '<' ─────────────────────────────────────
      case STATE.TAG_OPEN:
        if (ch === "/") {
          state = STATE.CLOSE_TAG;
        } else if (ch === "!") {
          // Could be comment <!-- or DOCTYPE <!
          // Peek ahead to decide
          const next2 = html.slice(i + 1, i + 3);
          if (next2 === "--") {
            // HTML comment
            i += 2; // skip '--'
            commentBuf = "";
            state = STATE.COMMENT;
          } else {
            // DOCTYPE or other <! token — skip until '>'
            state = STATE.DOCTYPE;
          }
        } else if (ch === "?" || ch === "%") {
          // Processing instruction or template tag — skip to '>'
          state = STATE.DOCTYPE;
        } else if (/[a-zA-Z]/.test(ch)) {
          tagName = ch;
          attrs   = {};
          state   = STATE.TAG_NAME;
        } else {
          // Stray '<' not followed by a valid tag character → treat as text
          buf += "<" + ch;
          state = STATE.TEXT;
        }
        break;

      // ── CLOSE_TAG: saw '</' ───────────────────────────────────────────────
      case STATE.CLOSE_TAG:
        if (/[a-zA-Z]/.test(ch)) {
          tagName = ch;
          state   = STATE.CLOSE_TAG_NAME;
        } else if (ch === ">") {
          // Malformed </> — ignore
          state = STATE.TEXT;
        } else {
          // e.g. '< / ' with spaces — skip to '>'
          state = STATE.DOCTYPE;
        }
        break;

      // ── TAG_NAME: accumulating open-tag name ──────────────────────────────
      case STATE.TAG_NAME:
        if (/[\s]/.test(ch)) {
          state = STATE.BEFORE_ATTR;
        } else if (ch === ">") {
          emitOpenTag(false);
          state = STATE.TEXT;
        } else if (ch === "/") {
          state = STATE.SELF_CLOSE;
        } else {
          tagName += ch;
        }
        break;

      // ── CLOSE_TAG_NAME: accumulating closing-tag name ─────────────────────
      case STATE.CLOSE_TAG_NAME:
        if (ch === ">" || /\s/.test(ch)) {
          tokens.push({ type: "close", tagName: tagName.toLowerCase() });
          tagName = "";
          // If whitespace, still need to skip to '>'
          if (/\s/.test(ch) && ch !== ">") {
            // Skip to closing '>'
            while (i < html.length && html[i] !== ">") i++;
          }
          state = STATE.TEXT;
        } else {
          tagName += ch;
        }
        break;

      // ── BEFORE_ATTR: whitespace between attributes ────────────────────────
      case STATE.BEFORE_ATTR:
        if (ch === ">") {
          emitOpenTag(false);
          state = STATE.TEXT;
        } else if (ch === "/") {
          state = STATE.SELF_CLOSE;
        } else if (!/\s/.test(ch)) {
          attrName  = ch;
          attrValue = "";
          state = STATE.ATTR_NAME;
        }
        break;

      // ── ATTR_NAME ─────────────────────────────────────────────────────────
      case STATE.ATTR_NAME:
        if (ch === "=") {
          state = STATE.ATTR_VALUE_START;
        } else if (/\s/.test(ch)) {
          state = STATE.AFTER_ATTR_NAME;
        } else if (ch === ">") {
          commitAttr();
          emitOpenTag(false);
          state = STATE.TEXT;
        } else if (ch === "/") {
          commitAttr();
          state = STATE.SELF_CLOSE;
        } else {
          attrName += ch;
        }
        break;

      // ── AFTER_ATTR_NAME: attr name done, checking for '=' ─────────────────
      case STATE.AFTER_ATTR_NAME:
        if (ch === "=") {
          state = STATE.ATTR_VALUE_START;
        } else if (ch === ">") {
          commitAttr();
          emitOpenTag(false);
          state = STATE.TEXT;
        } else if (ch === "/") {
          commitAttr();
          state = STATE.SELF_CLOSE;
        } else if (!/\s/.test(ch)) {
          // New attribute starting — commit current one first (boolean attr)
          commitAttr();
          attrName  = ch;
          attrValue = "";
          state = STATE.ATTR_NAME;
        }
        break;

      // ── ATTR_VALUE_START: we saw '=', decide quoting style ────────────────
      case STATE.ATTR_VALUE_START:
        if (ch === '"') {
          attrValue = "";
          state = STATE.ATTR_VALUE_DQ;
        } else if (ch === "'") {
          attrValue = "";
          state = STATE.ATTR_VALUE_SQ;
        } else if (ch === ">") {
          // Edge case: attr= with no value before '>'
          commitAttr();
          emitOpenTag(false);
          state = STATE.TEXT;
        } else if (!/\s/.test(ch)) {
          attrValue = ch;
          state = STATE.ATTR_VALUE_NQ;
        }
        // skip leading whitespace
        break;

      // ── ATTR_VALUE_DQ: inside double-quoted attribute value ───────────────
      case STATE.ATTR_VALUE_DQ:
        if (ch === '"') {
          commitAttr();
          state = STATE.BEFORE_ATTR;
        } else {
          attrValue += ch;
        }
        break;

      // ── ATTR_VALUE_SQ: inside single-quoted attribute value ───────────────
      case STATE.ATTR_VALUE_SQ:
        if (ch === "'") {
          commitAttr();
          state = STATE.BEFORE_ATTR;
        } else {
          attrValue += ch;
        }
        break;

      // ── ATTR_VALUE_NQ: unquoted attribute value ───────────────────────────
      case STATE.ATTR_VALUE_NQ:
        if (/\s/.test(ch)) {
          commitAttr();
          state = STATE.BEFORE_ATTR;
        } else if (ch === ">") {
          commitAttr();
          emitOpenTag(false);
          state = STATE.TEXT;
        } else if (ch === "/") {
          commitAttr();
          state = STATE.SELF_CLOSE;
        } else {
          attrValue += ch;
        }
        break;

      // ── COMMENT: inside <!-- ... --> ──────────────────────────────────────
      case STATE.COMMENT:
        if (ch === "-") {
          state = STATE.COMMENT_DASH1;
        } else {
          commentBuf += ch;
        }
        break;

      case STATE.COMMENT_DASH1:
        if (ch === "-") {
          state = STATE.COMMENT_DASH2;
        } else {
          commentBuf += "-" + ch;
          state = STATE.COMMENT;
        }
        break;

      case STATE.COMMENT_DASH2:
        if (ch === ">") {
          tokens.push({ type: "comment", content: commentBuf });
          commentBuf = "";
          state = STATE.TEXT;
        } else if (ch === "-") {
          // Still in '--' territory; extra dashes before '>' are legal
          commentBuf += "-";
          // stay in COMMENT_DASH2
        } else {
          // False alarm; '--' was inside the comment body
          commentBuf += "--" + ch;
          state = STATE.COMMENT;
        }
        break;

      // ── DOCTYPE / unknown <! ──────────────────────────────────────────────
      case STATE.DOCTYPE:
        if (ch === ">") {
          tokens.push({ type: "doctype" });
          state = STATE.TEXT;
        }
        // else: consume and discard
        break;

      // ── SELF_CLOSE: saw '/' inside tag (expecting '>') ───────────────────
      case STATE.SELF_CLOSE:
        if (ch === ">") {
          emitOpenTag(true);
          state = STATE.TEXT;
        } else if (!/\s/.test(ch)) {
          // Not actually self-closing (e.g. stray '/') — treat as attr char
          attrName  = ch;
          attrValue = "";
          state = STATE.ATTR_NAME;
        }
        break;

      default:
        // Unreachable, but safety net
        state = STATE.TEXT;
        break;
    }

    i++;
  }

  // End of input — flush any remaining text buffer
  flushText();

  return tokens;
}

// ---------------------------------------------------------------------------
// 3. ATTRIBUTE PARSER  (used after tokenization for extra safety)
// ---------------------------------------------------------------------------
// NOTE: Attribute parsing is embedded in the FSM above so this section
// documents the design rather than adding a second pass.

// ---------------------------------------------------------------------------
// 4. TREE BUILDER  (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Converts a flat token list into a nested JSON tree.
 *
 * @param {Array<Object>} tokens
 * @returns {Object} root node
 */
function buildTree(tokens) {
  /**
   * Factory for a new element node.
   */
  function makeElement(tagName, attributes) {
    return {
      type:       "element",
      tagName:    tagName,
      attributes: attributes || {},
      children:   [],
    };
  }

  // Virtual root acts as an invisible container so we always have a parent.
  const root  = makeElement("#root", {});
  const stack = [root];   // stack[stack.length - 1] is the current parent

  for (const token of tokens) {
    const parent = stack[stack.length - 1];

    switch (token.type) {

      case "doctype":
        // Represent <!DOCTYPE> as a metadata node on the root
        parent.children.push({ type: "doctype" });
        break;

      case "comment":
        parent.children.push({
          type:    "comment",
          content: token.content,
        });
        break;

      case "text": {
        // Trim pure-whitespace text nodes to keep the tree clean,
        // but preserve text that contains non-whitespace content.
        const trimmed = token.content.replace(/\s+/g, " ");
        if (trimmed.trim().length > 0) {
          parent.children.push({ type: "text", content: trimmed });
        }
        break;
      }

      case "open": {
        const node = makeElement(token.tagName, token.attributes);
        parent.children.push(node);
        // Push onto stack so subsequent tokens become its children
        stack.push(node);
        break;
      }

      case "self-close": {
        // Self-closing / void elements are never pushed onto the stack
        parent.children.push(makeElement(token.tagName, token.attributes));
        break;
      }

      case "close": {
        // Pop the stack to find the matching open tag.
        // If the closing tag doesn't match the top of the stack we walk
        // upward looking for a match — this handles missing closing tags.
        let matched = false;
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].tagName === token.tagName) {
            // Pop everything up to and including the matched tag
            stack.splice(k);
            matched = true;
            break;
          }
        }
        // If no match found at all, simply discard the stray close tag
        break;
      }

      default:
        break;
    }
  }

  // Any tags still on the stack are implicitly closed (unclosed-tag recovery)
  // — we just return the root; their nodes are already linked in the tree.

  // Unwrap: if the root has exactly one child, return that child as the root;
  // otherwise return the virtual #root so nothing is lost.
  if (root.children.length === 1) {
    return root.children[0];
  }
  return root;
}

// ---------------------------------------------------------------------------
// 5. PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Converts an HTML string into a structured JSON object.
 *
 * This function is intentionally wrapped in a try/catch so that ANY
 * unexpected error anywhere in the pipeline still returns a safe fallback
 * rather than propagating an exception to the caller.
 *
 * @param {string} htmlText - The HTML source to parse.
 * @returns {Object} A JSON-serialisable tree representing the HTML.
 */
function html2json(htmlText) {
  try {
    // Coerce to string — handles null, undefined, numbers, etc.
    if (typeof htmlText !== "string") {
      htmlText = String(htmlText == null ? "" : htmlText);
    }

    const tokens = tokenize(htmlText);
    const tree   = buildTree(tokens);
    return tree;

  } catch (err) {
    // Final safety net: never crash the caller
    return {
      type:    "error",
      message: "html2json encountered an internal error",
      detail:  String(err && err.message ? err.message : err),
    };
  }
}

// =============================================================================
//  UI GLUE  — original helper functions preserved exactly as provided
// =============================================================================

function convertHtml2JsonAndSet() {
  const htmlTextAreaValue = document.getElementById("html").value;
  const jsonObj = html2json(htmlTextAreaValue);
  const jsonArea = document.getElementById("json");
  jsonArea.textContent = JSON.stringify(jsonObj, null, 2);
}

function showExample1() {
  const htmlExample = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport">
    <title>Sample HTML</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>Welcome to My Website</h1>
    </header>
    <nav>
        <ul>
            <li><a href="#home">Home</a></li>
            <li><a href="#about">About</a></li>
            <li><a href="#contact">Contact</a></li>
        </ul>
    </nav>
    <main>
        <section id="home">
            <h2>Home Section</h2>
            <p>This is the home section of the webpage.</p>
        </section>
        <section id="about">
            <h2>About Section</h2>
            <p>This is the about section of the webpage.</p>
        </section>
    </main>
    <footer>
        <p>&copy; 2024 My Website</p>
    </footer>
    <script src="script.js"></script>
</body>
</html>
`;
  const jsonContent = {
    "Comment 1":
      "You have to think about how to take into account various html inputs so your json structure will cover them all and handle different cases.",
    "Comment 2":
      "When you make any choice in terms of selecting specific json structure for conversion - be ready to provide reasoning behind such choice.",
  };

  document.getElementById("html").value = htmlExample;
  document.getElementById("json").textContent = JSON.stringify(
    jsonContent,
    null,
    2
  );
}

function showExample2() {
  const htmlExample = `<div>
<p>Hello world!</p>
  <button>Click me!</button>
  <textarea>Some very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very long string.</textarea>
</div>
`;
  const jsonContent = {
    "Comment 1":
      "You have to think about how to take into account various html inputs so your json structure will cover them all and handle different cases.",
    "Comment 2":
      "When you make any choice in terms of selecting specific json structure for conversion - be ready to provide reasoning behind such choice.",
  };

  document.getElementById("html").value = htmlExample;
  document.getElementById("json").textContent = JSON.stringify(
    jsonContent,
    null,
    2
  );
}
