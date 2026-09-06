// 调试脚本：复现 codeHtml 管线，检查 MainWindow 函数是否被上色
import fs from 'fs';

const d = JSON.parse(fs.readFileSync('public/camera-index.json', 'utf-8'));
const mw = d.classes.find((c) => c.name === 'MainWindow');
const text = d.files[mw.file].split('\n').slice(mw.line - 1, mw.endLine).join('\n');

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let html = escHtml(text);

// ① labelPattern（类名 + 自由函数名）
const names = [...d.classes.map((c) => c.name), ...d.functions.map((f) => f.name)]
  .sort((a, b) => b.length - a.length);
html = html.replace(new RegExp(`\\b(${names.map(escRe).join('|')})\\b`, 'g'),
  (m) => `<span tok>${m}</span>`);
console.log('① 类名着色后函数区片段:');
console.log(html.split('\n').slice(8, 12).join('\n').slice(0, 300));

// ② 成员
const mems = [...new Set(mw.members.map((x) => x.name).filter(Boolean))];
html = html.replace(new RegExp(`\\b(${mems.map(escRe).join('|')})\\b`, 'g'),
  (m) => `<span mem>${m}</span>`);

// ③ 函数
html = html.replace(/\b[A-Za-z_]\w*(?=\s*\()/g, (m) => `<span fn>${m}</span>`);
const fnHits = [...html.matchAll(/<span fn>(\w+)<\/span>/g)].map((x) => x[1]);
console.log('③ fn 命中:', fnHits);
console.log('期望:', mw.methods.map((m) => m.name).join(', '));
