# html2json

> Convert any HTML string into a structured JSON tree — **no DOM, no libraries, no crashes**.

---

## Table of Contents

1. [Overview](#overview)
2. [Output Format](#output-format)
3. [Architectural Choice — Why a Finite-State Machine?](#architectural-choice--why-a-finite-state-machine)
4. [Pipeline: Two Phases](#pipeline-two-phases)
5. [Edge Case Handling](#edge-case-handling)
6. [Crash-Safety Guarantees](#crash-safety-guarantees)
7. [Test Samples](#test-samples)
8. [Usage](#usage)

---

## Overview

`html2json` is a **pure JavaScript** function that parses an HTML string without relying on `DOMParser`, `document`, or any browser APIs. It uses a custom **Finite-State Machine (FSM) tokenizer** combined with a **stack-based tree builder** to produce a clean, JSON-serialisable node tree.

---

## Output Format

Every node in the tree is one of the following shapes:

| Node type | Fields |
|-----------|--------|
| `element` | `type`, `tagName`, `attributes` (object), `children` (array) |
| `text` | `type`, `content` (trimmed string) |
| `comment` | `type`, `content` (raw comment body) |
| `doctype` | `type` only |
| `error` | `type`, `message`, `detail` — only on catastrophic internal failure |

### Example

```html
<div class="container" id="main">Hello <b>World</b></div>
```

```json
{
  "type": "element",
  "tagName": "div",
  "attributes": { "class": "container", "id": "main" },
  "children": [
    { "type": "text", "content": "Hello " },
    {
      "type": "element",
      "tagName": "b",
      "attributes": {},
      "children": [
        { "type": "text", "content": "World" }
      ]
    }
  ]
}
```

---

## Architectural Choice — Why a Finite-State Machine?

### The Problem With Pure Regex

HTML is a **context-sensitive** language. A single regex pattern cannot reliably distinguish between:

- `<` inside an attribute value vs. the start of a new tag
- `--` inside a comment body vs. the `-->` terminator
- A `/` as part of a URL attribute vs. the `/>` self-close marker
- Single-quoted, double-quoted, and unquoted attribute values

Naive regex approaches inevitably break on real-world HTML because they treat the entire string as a flat sequence of characters, with no notion of _where_ in the document a character appears.

### Why a State Machine Works

A **Finite-State Machine** (FSM) maintains an explicit notion of *context*. Every character is interpreted relative to the state the parser is currently in. For example:

- The character `"` means **nothing** in `STATE.TEXT` but **terminates an attribute value** in `STATE.ATTR_VALUE_DQ`.
- The character `-` means **append to comment** in `STATE.COMMENT` but means **check for `-->`** in `STATE.COMMENT_DASH1`.

This makes the parser's behaviour predictable, testable per-state, and easy to extend. It also means malformed input just causes the state machine to transition to an error-recovery state rather than producing a regex match failure or a thrown exception.

---

## Pipeline: Two Phases

```
Raw HTML string
      │
      ▼
┌─────────────────────────────────────────────────┐
│  Phase 1 — Tokenizer  (FSM, char-by-char)        │
│                                                  │
│  States: TEXT → TAG_OPEN → TAG_NAME              │
│          BEFORE_ATTR → ATTR_NAME                 │
│          ATTR_VALUE_DQ / SQ / NQ                 │
│          COMMENT → COMMENT_DASH1 → COMMENT_DASH2 │
│          DOCTYPE, SELF_CLOSE, CLOSE_TAG …        │
│                                                  │
│  Output: flat array of typed tokens              │
└─────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────┐
│  Phase 2 — Tree Builder  (stack-based)           │
│                                                  │
│  open    → push node onto stack                  │
│  close   → pop stack (with mismatch recovery)    │
│  self-close → append leaf, never push            │
│  text    → append to current parent              │
│  comment → append as comment node                │
│  doctype → append as doctype node                │
└─────────────────────────────────────────────────┘
      │
      ▼
  JSON tree
```

---

## Edge Case Handling

### Void / Self-Closing Elements

A hardcoded set (`VOID_ELEMENTS`) lists every HTML5 void element: `area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `param`, `source`, `track`, `wbr`. When the tokenizer emits any of these as an `open` token, `buildTree` treats it as `self-close` automatically — so they are never pushed onto the stack and the tree structure is never corrupted.

Additionally, XML-style `/>` syntax is recognised by the `SELF_CLOSE` state and also results in a self-closing token regardless of the element name.

### Attributes — All Quote Styles

| Style | Example | State |
|-------|---------|-------|
| Double-quoted | `class="foo"` | `ATTR_VALUE_DQ` |
| Single-quoted | `class='foo'` | `ATTR_VALUE_SQ` |
| Unquoted | `tabindex=0` | `ATTR_VALUE_NQ` (ends on whitespace or `>`) |
| Boolean | `disabled` | `ATTR_NAME` (no `=` follows → value set to `true`) |
| Empty | `value=""` | `ATTR_VALUE_DQ` yields empty string |

### HTML Comments

The tokenizer enters `STATE.COMMENT` on `<!--` and uses a two-step dash accumulation (`COMMENT_DASH1` → `COMMENT_DASH2`) to correctly recognise `-->`. Stray `--` inside a comment body are correctly consumed and appended to the comment content rather than terminating it early. Comments are emitted as `{ type: "comment", content: "..." }` nodes.

### DOCTYPE and Processing Instructions

`<!DOCTYPE ...>` is tokenised as `{ type: "doctype" }` and appended as a leaf node. Any `<?...?>` or `<%...%>` processing instructions are silently consumed (skipped to the next `>`).

### Unclosed Tags

The tree builder uses a **stack walk** when a closing tag is encountered: it searches down the stack from the top looking for a matching open tag. When found, it pops everything up to and including the matched tag (implicitly closing any orphaned elements in between). If no match is found, the stray `</tag>` is silently discarded.

When input ends with tags still on the stack, those nodes are already part of the tree (linked as children of their parent). They simply remain open — the tree is still fully traversable.

### Misnested Tags

For `<i><b>text</i></b>`, when `</i>` is processed the stack contains `[#root, i, b]`. The builder finds `i` at position 1, so it pops `b` and `i`, correctly closing both. The subsequent `</b>` finds no match and is discarded.

### Deeply Nested Structures

There is no recursion in either phase — both the FSM and the tree builder are **iterative** loops. JavaScript's call-stack depth is never a concern, even for documents nested hundreds of levels deep.

### Whitespace-Only Text Nodes

Pure-whitespace text nodes (newlines, indentation, spaces between tags) are collapsed to a single space and then dropped if their `.trim()` is empty. This keeps the tree clean without losing meaningful inline whitespace.

---

## Crash-Safety Guarantees

Three distinct layers prevent crashes:

1. **Input coercion** — Both `html2json` and `tokenize` convert non-string input to a string via `String(...)` before any processing begins. `null`, `undefined`, numbers, and objects are all handled.

2. **No recursion** — Iterative FSM and iterative stack-walk mean no stack-overflow risk from deeply nested HTML.

3. **Top-level try/catch** — `html2json` wraps the entire pipeline in a `try/catch`. If any unexpected error escapes the two phases (an unhandled edge case, a future browser engine quirk), the function returns an `error` node instead of propagating the exception:

```json
{
  "type": "error",
  "message": "html2json encountered an internal error",
  "detail": "<original error message>"
}
```

---

## Test Samples

The `html_samples/` folder contains five samples of increasing complexity:

| File | Description |
|------|-------------|
| `01_basic.html` | Standard well-formed HTML5 with doctype, head, body, nav, sections, void elements (`img`, `hr`). |
| `02_attributes.html` | Exercises all attribute styles: double-quoted, single-quoted, unquoted, boolean, empty, `data-*`, `aria-*`. |
| `03_void_and_comments.html` | Focuses on void elements (`br`, `hr`, `img`, `input`, `source`, `track`, `wbr`) and multi-line HTML comments. |
| `04_unclosed_tags.html` | Deliberately omits closing tags, uses misnesting, and includes stray closing tags with no matching opener. |
| `05_malformed_chaos.html` | Maximum stress test: broken DOCTYPE, reversed comment arrow, tags starting with numbers, truncated tags, stray angle brackets, empty tag names, junk between tags. |

---

## Usage

### Browser (via `<script>` tag)

```html
<script src="html2json.js"></script>
<script>
  const tree = html2json('<div class="hello"><p>World</p></div>');
  console.log(JSON.stringify(tree, null, 2));
</script>
```

### Node.js

```js
// Node doesn't have a global `document`, so the UI glue functions
// will throw if called — but html2json() itself works perfectly.
const { html2json } = require('./html2json.js'); // or just load the file

const fs   = require('fs');
const html = fs.readFileSync('./html_samples/01_basic.html', 'utf8');
const tree = html2json(html);
console.log(JSON.stringify(tree, null, 2));
```

> **Note:** The file also contains `convertHtml2JsonAndSet`, `showExample1`, and `showExample2` — these are UI helpers for the browser demo in `index.html` and depend on `document`. They are separate from the core `html2json` logic.
