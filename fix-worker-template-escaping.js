const fs = require('node:fs');

const input = process.argv[2] || 'worker.js';
const source = fs.readFileSync(input, 'utf8');

const startMarker = 'function getHTML(faviconUrl) {';
const start = source.indexOf(startMarker);
if (start < 0) throw new Error('getHTML(faviconUrl) was not found.');

const open = source.indexOf('return `', start);
const endMarker = '</html>`;';
const end = source.indexOf(endMarker, open);

if (open < 0 || end < 0) {
  throw new Error('Could not locate getHTML template boundaries.');
}

const bodyStart = open + 'return `'.length;
let body = source.slice(bodyStart, end);

const faviconToken = '__KEEP_FAVICON_INTERPOLATION__';
body = body.replaceAll('${faviconUrl}', faviconToken);

let fixed = '';

for (let i = 0; i < body.length; i++) {
  const ch = body[i];

  let slashes = 0;
  for (let j = i - 1; j >= 0 && body[j] === '\\'; j--) slashes++;

  const escaped = slashes % 2 === 1;

  if (ch === '`' && !escaped) {
    fixed += '\\`';
  } else if (ch === '$' && body[i + 1] === '{' && !escaped) {
    fixed += '\\${';
  } else {
    fixed += ch;
  }
}

fixed = fixed.replaceAll(faviconToken, '${faviconUrl}');

const output = source.slice(0, bodyStart) + fixed + source.slice(end);
fs.writeFileSync(input, output);

console.log(`Fixed nested template escaping in ${input}.`);
