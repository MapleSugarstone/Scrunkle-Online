// Evaluates the JavaScript expression in a file inside the running reference page (tools/ref-server.ts) and prints the JSON result.
// Usage: node tools/ref-eval.cjs <file.js>
const fs = require('node:fs');
const code = fs.readFileSync(process.argv[2], 'utf8');
fetch(`http://127.0.0.1:${process.env.REF_PORT ?? 8793}/eval`, { method: 'POST', body: code })
  .then((r) => r.text())
  .then((t) => console.log(t));
