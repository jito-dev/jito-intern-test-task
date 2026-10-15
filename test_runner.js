// test_runner.js — run with: node test_runner.js
"use strict";

const fs = require("fs");
const path = require("path");

// ── Load the core parser ──────────────────────────────────────────────────
// Strip the browser-only UI glue section before eval-ing
const src = fs.readFileSync(path.join(__dirname, "html2json.js"), "utf8");
const coreEnd = src.indexOf("// =============================================================================\n//  UI GLUE");
const core = coreEnd > -1 ? src.slice(0, coreEnd) : src;

// Evaluate in module scope so the functions are accessible here
let tokenize, buildTree, html2json;
try {
  // Function constructor avoids strict-mode eval scoping issues
  const loader = new Function(
    core + "\nreturn { tokenize, buildTree, html2json };"
  );
  ({ tokenize, buildTree, html2json } = loader());
} catch (e) {
  console.error("Failed to load html2json.js:", e.message);
  process.exit(1);
}

// ── Run samples ───────────────────────────────────────────────────────────
const samplesDir = path.join(__dirname, "html_samples");
const files = fs.readdirSync(samplesDir).sort();

let allOk = true;

console.log("=".repeat(60));
console.log("  html2json — Sample Test Runner");
console.log("=".repeat(60));

for (const f of files) {
  const html = fs.readFileSync(path.join(samplesDir, f), "utf8");
  let result;
  let threw = false;

  try {
    result = html2json(html);
    //    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    result = { type: "THREW", message: e.message };
    threw = true;
  }

  const ok = !threw && result && result.type !== "error" && result.type !== "THREW";
  const tag = result && result.tagName ? ` <${result.tagName}>` : "";
  const status = ok ? "✓ PASS" : "✗ FAIL";

  console.log(`\n${status}  ${f}`);
  console.log(`  root node: type="${result.type}"${tag}`);
  if (result && result.children) {
    console.log(`  children at root: ${result.children.length}`);
  }
  if (!ok) {
    allOk = false;
    console.log("  detail:", JSON.stringify(result, null, 2));
  }
}

console.log("\n" + "=".repeat(60));
console.log(allOk ? "  ALL 5 SAMPLES PASSED" : "  SOME SAMPLES FAILED");
console.log("=".repeat(60) + "\n");

process.exit(allOk ? 0 : 1);
