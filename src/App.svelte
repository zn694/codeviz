<script>
  import { onMount, onDestroy } from 'svelte';
  import { Graph } from '@antv/g6';
  import { classifyNodes, ROLES } from './classifier.js';
  import { buildGraph } from './loader.js';
  import FileTree from './FileTree.svelte';

  let container;
  let svgEl;
  let fileInput;
  let graph;

  // ---- 图数据状态 ----
  let G = { nodes: [], edges: [], functionOwners: {}, labelOwners: {}, entry: '' };
  let roles = [];
  let roleOf = {};
  let nodesById = {};
  const views = new Map();       // 弹出明细框：mtd:Class#fn / mem:Class#var
  let expanded = new Set();
  let selected = '';
  let refEdges = new Set();
  const viewMode = {};           // 类块 .h/.cpp 视图（保留切换按钮）
  let focusFn = null;
  const manualPos = {};
  const zMap = {};               // 层级：点击的框最上层
  let zTop = 0;
  let menu = null;
  let lastKey = '';
  let fileTree = [];
  let dbg = '';   // 调试读数（临时）

  // ---- 文件树 ----
  function buildTree(paths) {
    const root = { children: [] };
    for (const p of [...paths].sort()) {
      const parts = p.split('/');
      let node = root;
      parts.forEach((name, i) => {
        const isFile = i === parts.length - 1;
        let child = node.children.find((c) => c.name === name);
        if (!child) {
          child = { name, path: parts.slice(0, i + 1).join('/'),
                    dir: !isFile, children: [], open: false };
          node.children.push(child);
        }
        node = child;
      });
    }
    return root.children;
  }

  function ensureFileView(path) {
    const vid = `file:${path}`;
    if (!views.has(vid)) {
      views.set(vid, {
        id: vid,
        data: { label: path },
        syntax: { kind: 'struct' },
        header: G.files?.[path] || '',   // 完整文件内容
        impl: '',
      });
    }
    return vid;
  }

  function openFileView(path) {
    const vid = ensureFileView(path);
    // 首次打开放在视野中央附近（否则默认布局列可能在视口外）
    if (!manualPos[vid]) manualPos[vid] = { x: 240, y: 80 };
    zMap[vid] = ++zTop;   // 新框默认最上层
    expanded.add(vid);
    selected = vid;
    expanded = new Set(expanded);
    menu = null;
    refresh();
  }

  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fnPattern = /\b[A-Za-z_]\w*(?=\s*\()/g;
  let labelPattern = /(?!) /;
  let varPattern = /(?!) /;

  function rebuildPattern() {
    const names = Object.keys(G.labelOwners).sort((a, b) => b.length - a.length);
    labelPattern = names.length
      ? new RegExp(`\\b(${names.map(escRe).join('|')})\\b`, 'g')
      : /(?!) /;
    const vnames = Object.keys(G.variables || {}).sort((a, b) => b.length - a.length);
    varPattern = vnames.length
      ? new RegExp(`\\b(${vnames.map(escRe).join('|')})\\b`, 'g')
      : /(?!) /;
  }

  // 节点查找：主块 + 弹出明细框
  const allNodeIds = () => [...G.nodes.map((n) => n.id), ...views.keys()];
  const getNode = (id) => nodesById[id] ?? views.get(id);

  function applyIndex(json) {
    G = buildGraph(json);
    roles = classifyNodes(G.nodes, G.edges);
    roleOf = Object.fromEntries(roles.map((r) => [r.id, r]));
    nodesById = Object.fromEntries(G.nodes.map((n) => [n.id, n]));
    views.clear();
    expanded = new Set([G.entry]);
    selected = G.entry;
    refEdges = new Set();
    for (const k of Object.keys(viewMode)) delete viewMode[k];
    for (const k of Object.keys(manualPos)) delete manualPos[k];
    for (const k of Object.keys(zMap)) delete zMap[k];
    focusFn = null;
    menu = null;
    rebuildPattern();
    fileTree = buildTree(Object.keys(G.files || {}));
    refresh();
    graph.fitCenter();
  }

  // ---- 弹出明细框 ----
  const sliceOf = (path, from, to) => {
    const text = G.files?.[path];
    return text;
  };

  function ensureVarView(name) {
    const vid = `var:${name}`;
    if (!views.has(vid)) {
      const v = G.variables?.[name];
      const text = v ? slice(v.file, v.line, v.endLine) : '// 声明未找到';
      views.set(vid, {
        id: vid,
        data: { label: name },
        syntax: { kind: 'struct' },
        header: (v ? `// ${v.file}:${v.line}\n` : '') + text,
        impl: '',
      });
    }
    return vid;
  }

  function ensureLocVarView(owner, name) {
    const vid = `lv:${owner}#${name}`;
    if (!views.has(vid)) {
      const decls = G.locals?.[name] || [];
      const d = decls.find((x) => x.owner === owner) || decls[0];
      const text = d ? slice(d.file, d.line, d.endLine) : '// 声明未找到';
      views.set(vid, {
        id: vid,
        data: { label: `${owner}::${name}` },
        syntax: { kind: 'struct' },
        owner,
        header: (d ? `// ${d.file}:${d.line}\n` : '') + text,
        impl: '',
      });
    }
    return vid;
  }

  // 当前方块对应的"归属函数名"集合（局部变量上色与解析范围）
  function ownerNamesFor(id) {
    if (id.startsWith('mtd:')) {
      const v = views.get(id);
      return v?.owner ? [v.owner] : [];
    }
    if (id.startsWith('fn:')) return [id.slice(3)];
    if (id.startsWith('cls:')) return (nodesById[id]?.methodData || []).map((m) => m.name);
    return [];
  }

  function ensureMemberView(clsId, name) {
    const vid = `mem:${clsId}#${name}`;
    if (!views.has(vid)) {
      const cls = nodesById[clsId];
      const m = cls.memberData?.find((x) => x.name === name);
      const text = m ? slice(m.file, m.line, m.endLine) : '// 声明未找到';
      views.set(vid, {
        id: vid,
        data: { label: `${cls.data.label}::${name}` },
        syntax: { kind: 'struct' },
        header: (m ? `// ${m.file}:${m.line}\n` : '') + text,
        impl: '',
      });
    }
    return vid;
  }

  function ensureMethodView(clsId, name) {
    const vid = `mtd:${clsId}#${name}`;
    if (!views.has(vid)) {
      const cls = nodesById[clsId];
      const m = cls.methodData?.find((x) => x.name === name);
      const text = m ? slice(m.file, m.line, m.endLine) : '// 实现未找到';
      views.set(vid, {
        id: vid,
        data: { label: `${cls.data.label}::${name}` },
        syntax: { kind: 'function', runLike: true },
        owner: name,
        header: (m ? `// ${m.file}:${m.line}\n` : '') + text,
        impl: '',
      });
    }
    return vid;
  }

  function slice(path, from, to) {
    const text = G.files?.[path];
    if (!text) return '';
    const lines = text.split('\n');
    return lines.slice(Math.max(0, from - 1), Math.max(from, to)).join('\n');
  }

  // ---- 方块 HTML ----
  function codeHtml(id) {
    const n = getNode(id);
    if (!n) return '';
    const roleInfo = roleOf[id] || (id.startsWith('mem:') ? { role: 'data', confidence: 1 }
                                  : { role: 'impl', confidence: 1 });
    const mode = viewMode[id] || 'h';
    const text = mode === 'h' ? n.header : (n.impl || n.header);

    let html = escHtml(text);
    // ① 项目符号名 → 角色色（候选列表）
    html = html.replace(labelPattern, (m) => {
      const owners = G.labelOwners[m];
      if (!owners || owners.length === 0) return m;
      if (owners.length === 1 && owners[0] === id) return m;
      const c = ROLES[roleOf[owners[0]]?.role]?.color || '#6B7280';
      return `<span class="tok" style="color:${c}" data-targets="${owners.join(',')}" data-from="${id}">${m}</span>`;
    });
    // ② 成员变量 → 弹出明细框（类块 h/cpp 视图 + 方法明细框都生效）
    const memberData = id.startsWith('cls:')
      ? n.memberData
      : id.startsWith('mtd:')
        ? nodesById[id.slice(4).split('#')[0]]?.memberData
        : null;
    const memberClsId = id.startsWith('cls:') ? id : id.slice(4).split('#')[0];
    if (memberData?.length) {
      const memNames = [...new Set(memberData.map((x) => x.name).filter(Boolean))];
      if (memNames.length) {
        const memPattern = new RegExp(`\\b(${memNames.map(escRe).join('|')})\\b`, 'g');
        html = html.replace(memPattern, (m) =>
          `<span class="mem" data-member="${memberClsId}" data-member-name="${m}">${m}</span>`);
      }
    }
    // ③ 全局/文件级变量 → 点击弹声明框
    html = html.replace(varPattern, (m) =>
      `<span class="var" data-var-name="${m}" data-from="${id}">${m}</span>`);
    // ③.5 局部变量/参数（限定在当前方块归属函数内）→ 点击弹声明框
    const owners = ownerNamesFor(id);
    if (owners.length && G.locals) {
      const locNames = new Set();
      for (const [nm, decls] of Object.entries(G.locals))
        if (decls.some((d) => owners.includes(d.owner))) locNames.add(nm);
      if (locNames.size) {
        const locPattern = new RegExp(
          `\\b(${[...locNames].sort((a, b) => b.length - a.length).map(escRe).join('|')})\\b`, 'g');
        html = html.replace(locPattern, (m) =>
          `<span class="loc" data-locvar="${m}" data-from="${id}">${m}</span>`);
      }
    }
    // ④ 函数名 → 弹出实现明细框（类方法）或打开自由函数方块
    html = html.replace(fnPattern, (m) => {
      const owners = G.functionOwners[m] || [];
      let list = owners;
      if (owners.includes(id)) list = [id];
      if (list.length === 0) return m;
      return `<span class="fn" data-fn="${list.join(',')}" data-from="${id}" data-fn-name="${m}">${m}</span>`;
    });
    if (mode === 'cpp') {
      html = html.replace(/(\b\w+::)(\w+)(\s*\()/g, (all, pre, name, paren) =>
        `<span class="fndef${focusFn === name ? ' on' : ''}" data-fndef="${name}">${pre}${name}</span>${paren}`);
    }

    const border = id === selected ? '#D97757'
                 : roleInfo.confidence < 0.7 ? '#C2410C'
                 : '#E8E6DC';
    const tab = (t, name) =>
      `<button class="tab ${mode === t ? 'on' : ''}" data-tab="${t}" data-node="${id}">${name}</button>`;
    const hasImpl = id.startsWith('cls:') && n.impl;
    const scrollCls = id.startsWith('file:') ? ' scrollable' : '';
    return `<div class="cb${scrollCls}" data-node-id="${id}" style="border:1.5px solid ${border}">
      <div class="cb-t">
        <span class="cb-name">${n.data.label}</span>
        <span class="cb-role" style="color:${ROLES[roleInfo.role]?.color || '#6B7280'}">${ROLES[roleInfo.role]?.label || ''}${roleInfo.confidence < 0.7 ? ' ⚠' : ''}</span>
        ${hasImpl ? `<span class="cb-tabs">${tab('h', '.h')}${tab('cpp', '.cpp')}</span>` : ''}
        <button class="cb-close" data-close="${id}" title="关闭">✕</button>
      </div>
      <pre class="cb-c">${html}</pre>
    </div>`;
  }

  const CHAR_W = 6.05;   // Consolas 11px 实际字符宽（0.55em）——估宽不准会被迫折行
  const sizeCache = {};
  // 行宽单位：全角字符（中文等）占 2 单位
  const lineUnits = (l) => {
    let u = 0;
    for (const ch of l) u += ch.charCodeAt(0) > 0x2E80 ? 2 : 1;
    return Math.max(1, u);
  };
  function blockSize(id) {
    const key = `${id}:${viewMode[id] || 'h'}`;
    if (sizeCache[key]) return sizeCache[key];
    const n = getNode(id);
    if (!n) return { width: 300, height: 80 };
    const text = (viewMode[id] || 'h') === 'h' ? n.header : (n.impl || n.header);
    const lines = text.split('\n');
    const maxUnits = Math.max(...lines.map(lineUnits));
    // 宽度完全按最长行（不设上限，避免被迫折行）；仅保最小值
    const width = Math.max(280, maxUnits * CHAR_W + 48);
    const unitsPerLine = Math.max(24, Math.floor((width - 24) / CHAR_W));
    let totalLines = 0;
    for (const l of lines) totalLines += Math.max(1, Math.ceil(lineUnits(l) / unitsPerLine));
    let height = 42 + totalLines * 16.5 + 26;  // 尾部多留余量
    // 文件视图：高度封顶（视口 70%），内部滚动看全文
    if (id.startsWith('file:') && container) {
      height = Math.min(height, Math.round(container.clientHeight * 0.7));
    }
    sizeCache[key] = { width, height };
    return sizeCache[key];
  }

  function layerPositions(vNodes, vEdges) {
    const depth = { [G.entry]: 0 };
    const queue = [G.entry];
    const seen = new Set([G.entry]);
    while (queue.length) {
      const id = queue.shift();
      for (const e of vEdges) {
        if (e.source === id && !seen.has(e.target)) {
          seen.add(e.target);
          depth[e.target] = depth[id] + 1;
          queue.push(e.target);
        }
      }
    }
    const byDepth = {};
    for (const n of vNodes) {
      const d = depth[n.id] ?? 1;
      (byDepth[d] ||= []).push(n);
    }
    const pos = {};
    let x = 40;
    const maxDepth = Math.max(0, ...Object.keys(byDepth).map(Number));
    for (let d = 0; d <= maxDepth; ++d) {
      const arr = byDepth[d] || [];
      let y = 60;
      for (const n of arr) {
        pos[n.id] = { x, y };
        y += blockSize(n.id).height + 36;
      }
      x += Math.max(0, ...arr.map((n) => blockSize(n.id).width)) + 60;
    }
    return pos;
  }

  function visibleData() {
    const vNodes = [...G.nodes, ...views.values()].filter((n) => expanded.has(n.id));
    const vEdges = G.edges.filter((e) => expanded.has(e.source) && expanded.has(e.target));
    const pos = layerPositions(vNodes, vEdges);
    return {
      nodes: vNodes.map((n) => {
        const s = blockSize(n.id);
        const p = manualPos[n.id] || pos[n.id];
        return {
          ...n,
          data: { html: codeHtml(n.id) },
          style: { x: p.x, y: p.y, size: [s.width, s.height], zIndex: zMap[n.id] || 1 },
        };
      }),
      edges: [],
    };
  }

  function refresh() {
    if (!graph) return;
    graph.setData(visibleData());
    graph.render();
    // 下一帧再校准：G6 的 HTML 节点 DOM 插入有延迟，立即查会扑空
    requestAnimationFrame(calibrateSizes);
  }

  // 渲染后实测修正：估算公式有误差时，按真实内容高度修正一次再重渲（防内容被裁）
  function calibrateSizes() {
    let changed = false;
    for (const id of expanded) {
      const key = `${id}:${viewMode[id] || 'h'}`;
      const cb = container.querySelector(`[data-node-id="${id}"]`);
      const pre = cb?.querySelector('.cb-c');
      if (!cb || !pre) continue;
      const cur = sizeCache[key];
      if (!cur) continue;
      const titleH = cb.querySelector('.cb-t')?.offsetHeight || 30;
      const need = pre.scrollHeight + titleH + 6;
      if (need > cur.height + 4) {
        sizeCache[key] = { width: cur.width, height: Math.ceil(need) };
        changed = true;
      }
    }
    if (changed) {
      graph.setData(visibleData());
      graph.render();
      requestAnimationFrame(calibrateSizes);  // 修正后再校一遍（防仍偏小）
    }
  }

  // ---- 放置：从"点击的词"出发——取该词到来源框的最近边框点，沿外法线贴边放 ----
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function placeNear(from, target, token) {
    if (!graph) return;
    const src = manualPos[from] || graph.getNodeData(from)?.style || null;
    const tw = blockSize(target).width, th = blockSize(target).height;
    // 框出现在鼠标（点击词）位置：以光标为中心（已打开的框也移过来）
    if (token && token.x != null) {
      manualPos[target] = { x: token.x - tw / 2, y: token.y - th / 2 };
      return;
    }
    // 无 token（候选菜单等）：放在来源框旁边
    if (src && src.x != null) {
      manualPos[target] = { x: src.x + blockSize(from).width + 60, y: src.y };
    }
  }

  // ---- SVG 箭头 ----
  function elementRect(el) {
    if (!el) return null;
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
  }
  function blockRect(id) { return elementRect(container.querySelector(`[data-node-id="${id}"]`)); }
  function tokenRect(fromId, kind, name, occ) {
    const attr = kind === 'fn' ? 'data-fn-name'
               : kind === 'mem' ? 'data-member-name'
               : kind === 'var' ? 'data-var-name'
               : kind === 'loc' ? 'data-locvar' : 'data-targets';
    let idx = 0;
    for (const sp of container.querySelectorAll(`[data-node-id="${fromId}"] [${attr}]`)) {
      if (sp.textContent !== name) continue;
      if (idx === (occ || 0)) return elementRect(sp);
      idx++;
    }
    return null;
  }
  function borderPoint(rect, x, y) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const dx = x - cx, dy = y - cy;
    const scale = Math.min(Math.abs(rect.w / 2 / (dx || 1e-6)), Math.abs(rect.h / 2 / (dy || 1e-6)));
    return { x: cx + dx * scale, y: cy + dy * scale };
  }
  function bezier(p1, p2) {
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = Math.min(60, len * 0.25);
    return { cx: mx - dy / len * off, cy: my + dx / len * off };
  }

  function redrawEdges() {
    if (!svgEl || !graph) return;
    const refList = [...refEdges]
      .map((k) => {
        const [pair, kind, name, occ] = k.split('|');
        const [s, t] = pair.split('>');
        return { s, t, kind, name, occ: parseInt(occ || '0', 10) };
      })
      .filter((e) => expanded.has(e.s) && expanded.has(e.t));
    // 同一对节点已有引用线 → 抑制调用线（避免"词上的线 + 额外灰线"重复）
    const refPairs = new Set(refList.map((e) => `${e.s}>${e.t}`));
    const callEdges = G.edges.filter((e) =>
      expanded.has(e.source) && expanded.has(e.target)
      && !refPairs.has(`${e.source}>${e.target}`));
    const items = [];
    let key = '';
    for (const e of callEdges) {
      const s = blockRect(e.source), t = blockRect(e.target);
      if (!s || !t) continue;
      items.push({ p1: { x: s.x + s.w, y: s.y + s.h / 2 }, p2: borderPoint(t, s.x + s.w, s.y + s.h / 2), cls: 'call' });
      key += `${e.source}${e.target}${s.x.toFixed(0)}${s.y.toFixed(0)}${t.x.toFixed(0)}${t.y.toFixed(0)};`;
    }
    for (const e of refList) {
      const s = e.s, t = e.t;
      const srcRect = blockRect(s), dstRect = blockRect(t);
      if (!srcRect || !dstRect) continue;
      const tok = tokenRect(s, e.kind, e.name, e.occ);
      const p1 = tok
        ? { x: tok.x + tok.w / 2, y: tok.y + tok.h / 2 }
        : { x: srcRect.x + srcRect.w, y: srcRect.y + srcRect.h / 2 };
      items.push({ p1, p2: borderPoint(dstRect, p1.x, p1.y), cls: 'ref' });
      key += `r${s}${t}${p1.x.toFixed(0)}${p1.y.toFixed(0)}${dstRect.x.toFixed(0)}${dstRect.y.toFixed(0)};`;
    }
    if (key === lastKey) return;
    lastKey = key;
    let paths = '';
    for (const it of items) {
      const b = bezier(it.p1, it.p2);
      paths += `<path class="${it.cls}" d="M ${it.p1.x} ${it.p1.y} Q ${b.cx} ${b.cy} ${it.p2.x} ${it.p2.y}"/>`;
    }
    svgEl.innerHTML =
      `<defs><marker id="arrowCall" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" fill="#C9C2B4"/></marker>
       <marker id="arrowRef" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" fill="#D97757"/></marker></defs>` + paths;
  }

  // ---- 交互 ----
  // 点击的是块内第几个同名符号（同名多次出现时精确定位）
  function occIndexOf(el) {
    const block = el.closest('[data-node-id]');
    if (!block) return 0;
    const name = el.textContent;
    const attr = el.hasAttribute('data-targets') ? 'data-targets'
               : el.hasAttribute('data-fn-name') ? 'data-fn-name'
               : el.hasAttribute('data-member-name') ? 'data-member-name'
               : el.hasAttribute('data-var-name') ? 'data-var-name' : 'data-locvar';
    let idx = 0;
    for (const sp of block.querySelectorAll(`[${attr}]`)) {
      if (sp === el) return idx;
      if (sp.textContent === name) idx++;
    }
    return 0;
  }

  // 取点击词的中心——从 G6 画布层的 CSS transform 矩阵反推
  // （G6 5.1 的相机 API getViewportCenter 返回 NaN，不可用）
  function clientToCanvas(cx, cy) {
    const cr = container.getBoundingClientRect();
    // 找第一个带 transform 的层（G6 的 canvas 包装层，translate+scale）
    let m = null;
    for (const el of container.querySelectorAll('div, canvas')) {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') { m = new DOMMatrixReadOnly(t); break; }
    }
    const tx = m ? m.e : 0, ty = m ? m.f : 0, s = m ? m.a : 1;
    return {
      x: (cx - cr.left - tx) / s,
      y: (cy - cr.top - ty) / s,
    };
  }
  function tokenCenter(el) {
    const r = el.getBoundingClientRect();
    const p = clientToCanvas(r.left + r.width / 2, r.top + r.height / 2);
    const cr = container.getBoundingClientRect();
    dbg = `click(${Math.round(r.left + r.width / 2 - cr.left)},${Math.round(r.top + r.height / 2 - cr.top)})`
      + ` → canvas(${Math.round(p.x)},${Math.round(p.y)})`
      + ` zoom=${graph.getZoom().toFixed(2)}`;
    return p;
  }

  function openTarget(from, target, token, edgeMeta) {
    // 引用线记录"点了哪个词"：kind=符号类型 name=词文本 occ=第几个同名出现
    if (from !== target)
      refEdges.add(`${from}>${target}|${edgeMeta?.kind || 'tok'}|${edgeMeta?.name || ''}|${edgeMeta?.occ || 0}`);
    placeNear(from, target, token);
    zMap[target] = ++zTop;   // 新框默认最上层
    expanded.add(target);
    selected = target;
    expanded = new Set(expanded);
    refEdges = new Set(refEdges);
    menu = null;
    refresh();
  }

  function pickCandidate(from, ids, el, name) {
    const token = tokenCenter(el);
    const occ = occIndexOf(el);
    if (ids.length === 1) {
      if (name) focusFn = name;
      openTarget(from, ids[0], token,
        { kind: name ? 'fn' : 'tok', name: name || el.textContent, occ });
      return;
    }
    const r = el.getBoundingClientRect();
    menu = { x: r.left, y: r.bottom + 4, token,
             items: ids.map((id) => ({ id, label: getNode(id)?.data.label || id })),
             from, fnName: name, tokName: el.textContent, occ };
  }

  function chooseMenu(id) {
    const { from, fnName, token, tokName, occ } = menu;
    if (fnName) focusFn = fnName;
    openTarget(from, id, token,
      { kind: fnName ? 'fn' : 'tok', name: fnName || tokName, occ });
  }

  function openFunction(from, ownerId, name, el) {
    focusFn = name;
    const occ = occIndexOf(el);
    if (ownerId.startsWith('cls:')) {
      openTarget(from, ensureMethodView(ownerId, name), tokenCenter(el), { kind: 'fn', name, occ });
    } else {
      openTarget(from, ownerId, tokenCenter(el), { kind: 'fn', name, occ });  // 自由函数
    }
  }

  function openMember(from, clsId, name, el) {
    openTarget(from, ensureMemberView(clsId, name), tokenCenter(el),
      { kind: 'mem', name, occ: occIndexOf(el) });
  }

  function expandDownstream(id) {
    selected = id;
    for (const e of G.edges) if (e.source === id) expanded.add(e.target);
    expanded = new Set(expanded);
    refresh();
  }

  function bringToFront(id) {
    zMap[id] = ++zTop;
    refresh();
  }

  async function importIndex(file) {
    const text = await file.text();
    applyIndex(JSON.parse(text));
  }

  onMount(async () => {
    graph = new Graph({
      container,
      autoResize: true,
      data: { nodes: [], edges: [] },
      node: { type: 'html', style: { innerHTML: (d) => d.data.html } },
      // 滚轮缩放由自定义 wheel 监听接管（框内滚轮同样全局缩放）
      behaviors: ['drag-canvas', 'drag-element'],
    });
    graph.render();

    graph.on('afterrender', () => {
      for (const n of graph.getNodeData()) {
        if (n.style?.x != null) manualPos[n.id] = { x: n.style.x, y: n.style.y };
      }
    });

    // 滚轮全局缩放：window 级捕获（G6 内部可能拦截容器级事件），
    // 鼠标在画布区域内（含方块上）就缩放；缩放中心 = 鼠标位置（视口坐标）
    window.addEventListener('wheel', (e) => {
      const c = container.getBoundingClientRect();
      if (e.clientX < c.left || e.clientX > c.right || e.clientY < c.top || e.clientY > c.bottom)
        return;
      e.preventDefault();
      const ratio = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      graph.zoomBy(ratio, undefined, { x: e.clientX - c.left, y: e.clientY - c.top });
    }, { passive: false, capture: true });

    const loop = () => {
      // 每帧同步拖动后的位置（drag 过程中 afterrender 不触发，不同步会"自动归位"）
      for (const n of graph.getNodeData()) {
        if (n.style?.x != null) {
          const m = manualPos[n.id];
          if (!m || m.x !== n.style.x || m.y !== n.style.y)
            manualPos[n.id] = { x: n.style.x, y: n.style.y };
        }
      }
      redrawEdges();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    container.addEventListener('click', (e) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (!hit) return;
      const tok = hit.closest('[data-targets]');
      if (tok) { pickCandidate(tok.dataset.from, tok.dataset.targets.split(','), tok); return; }
      const mem = hit.closest('[data-member]');
      if (mem) { openMember(mem.dataset.from, mem.dataset.member, mem.dataset.memberName, mem); return; }
      const vr = hit.closest('[data-var-name]');
      if (vr) {
        openTarget(vr.dataset.from, ensureVarView(vr.dataset.varName),
                   tokenCenter(vr), { kind: 'var', name: vr.dataset.varName, occ: occIndexOf(vr) });
        return;
      }
      const lv = hit.closest('[data-locvar]');
      if (lv) {
        const fromOwners = ownerNamesFor(lv.dataset.from);
        const decls = G.locals?.[lv.dataset.locvar] || [];
        const owner = (decls.find((d) => fromOwners.includes(d.owner)) || decls[0])?.owner || '';
        openTarget(lv.dataset.from, ensureLocVarView(owner, lv.dataset.locvar),
                   tokenCenter(lv), { kind: 'loc', name: lv.dataset.locvar, occ: occIndexOf(lv) });
        return;
      }
      const fn = hit.closest('[data-fn]');
      if (fn) {
        const owners = fn.dataset.fn.split(',');
        if (owners.length === 1) openFunction(fn.dataset.from, owners[0], fn.dataset.fnName, fn);
        else pickCandidate(fn.dataset.from, owners, fn, fn.dataset.fnName);
        return;
      }
      const tab = hit.closest('[data-tab]');
      if (tab) { viewMode[tab.dataset.node] = tab.dataset.tab; focusFn = null; refresh(); return; }
      const close = hit.closest('[data-close]');
      if (close) {
        // 连带关闭：递归关掉所有"从这个框点开"的子框（按引用线 from→to 关系）
        const refPairs = [...refEdges].map((k) => {
          const [pair] = k.split('|');
          return pair.split('>');
        });
        const queue = [close.dataset.close];
        const doomed = new Set();
        while (queue.length) {
          const cur = queue.shift();
          if (doomed.has(cur)) continue;
          doomed.add(cur);
          expanded.delete(cur);
          views.delete(cur);
          delete manualPos[cur];
          delete zMap[cur];
          delete viewMode[cur];
          for (const [s, t] of refPairs) if (s === cur) queue.push(t);
        }
        expanded = new Set(expanded);
        refresh();
        return;
      }
      // 点到方块空白处 → 置顶
      const block = hit.closest('[data-node-id]');
      if (block) bringToFront(block.dataset.nodeId);
    }, true);

    try {
      // ?t= 缓存穿透：索引重新生成后强制取新版（否则浏览器可能用旧缓存）
      const res = await fetch(`/camera-index.json?t=${Date.now()}`);
      if (res.ok) applyIndex(await res.json());
    } catch { /* 等待导入 */ }
  });

  let rafId = 0;
  onDestroy(() => {
    cancelAnimationFrame(rafId);
    graph?.destroy();
  });

  // HMR 会保留组件状态（旧符号表/旧实例残留，多次"修了没生效"的根源）：
  // 直接改为保存后整页刷新——开发期代价可忽略，换确定性
  if (import.meta.hot) {
    import.meta.hot.accept(() => location.reload());
  }
</script>

<div class="page">
  <div class="header">
    <span class="title">CodeViz</span>
    <span class="hint">类=方块（.h/.cpp 可切）· 成员变量/函数=弹出明细框 · 点击框置顶 · 拖动可重叠</span>
    <button class="btn" onclick={() => fileInput.click()}>导入索引</button>
    <button class="reset" onclick={() => graph?.zoomTo(1)}>复位 100%</button>
    <input bind:this={fileInput} type="file" accept=".json" style="display:none"
           onchange={(e) => e.target.files[0] && importIndex(e.target.files[0])} />
  </div>
  <div class="legend">
    {#each Object.entries(ROLES) as [key, r]}
      <span class="chip"><i style="background:{r.color}"></i>{r.label}</span>
    {/each}
  </div>
  <div class="main">
    <div bind:this={container} class="graph">
      <svg bind:this={svgEl} class="edges"></svg>
    </div>
    <div class="file-panel">
      <div class="file-title">文件
        <span class="file-count">{Object.keys(G.files || {}).length} 个</span>
      </div>
      <FileTree tree={fileTree} onFile={openFileView} />
    </div>
  </div>

  {#if menu}
    <div class="menu" style="left:{menu.x}px;top:{menu.y}px">
      {#each menu.items as it}
        <button onclick={() => chooseMenu(it.id)}>{it.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    background: #FAF9F5;
    font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
    color: #1F1E1D;
  }
  .page { display: flex; flex-direction: column; height: 100vh; }
  .header {
    padding: 10px 20px;
    background: #FFFFFF;
    border-bottom: 1px solid #E8E6DC;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 17px;
    font-weight: 600;
    color: #1F1E1D;
    margin-right: 8px;
  }
  .hint { color: #6B6860; font-size: 12px; flex: 1; }
  .btn, .reset {
    background: #D97757;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 5px 14px;
    font-size: 12px;
    cursor: pointer;
  }
  .btn:hover, .reset:hover { background: #C15F3C; }
  .legend {
    display: flex;
    gap: 14px;
    padding: 8px 20px;
    background: #F0EEE6;
    border-bottom: 1px solid #E8E6DC;
  }
  .chip { display: inline-flex; align-items: center; gap: 6px; color: #4A4740; font-size: 12px; }
  .chip i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .main { display: flex; flex: 1; min-height: 0; }
  .graph { flex: 1; position: relative; min-width: 0; }
  .file-panel {
    width: 260px;
    min-width: 260px;
    background: #FFFFFF;
    border-left: 1px solid #E8E6DC;
    overflow-y: auto;
    padding: 12px 10px;
  }
  .file-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 14px;
    font-weight: 600;
    color: #1F1E1D;
    margin-bottom: 8px;
  }
  .file-count { font-size: 11px; color: #9A968A; font-weight: 400; margin-left: 6px; }
  .edges {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 999;
  }
  .edges :global(.call) {
    fill: none; stroke: #C9C2B4; stroke-width: 1.5; marker-end: url(#arrowCall);
  }
  .edges :global(.ref) {
    fill: none; stroke: #D97757; stroke-width: 1.5; stroke-dasharray: 6 4; marker-end: url(#arrowRef);
  }
  .menu {
    position: fixed;
    background: #FFFFFF;
    border: 1px solid #E8E6DC;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(31, 30, 29, 0.15);
    padding: 4px;
    z-index: 2000;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    border: none;
    background: transparent;
    text-align: left;
    padding: 7px 14px;
    font-size: 12px;
    font-family: 'Consolas', monospace;
    color: #1F1E1D;
    cursor: pointer;
    border-radius: 5px;
  }
  .menu button:hover { background: #F0EEE6; }

  :global(.cb) {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    background: #FFFFFF;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 1px 4px rgba(31, 30, 29, 0.08);
  }
  :global(.cb-t) {
    padding: 7px 10px;
    border-bottom: 1px solid #F0EEE6;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  :global(.cb-name) {
    font-family: 'Consolas', monospace;
    font-size: 13px;
    font-weight: 600;
    color: #1F1E1D;
  }
  :global(.cb-role) { font-size: 11px; font-weight: 600; }
  :global(.cb-tabs) { margin-left: 8px; display: flex; gap: 2px; }
  :global(.tab) {
    background: transparent;
    border: 1px solid #E8E6DC;
    color: #6B6860;
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 11px;
    cursor: pointer;
    font-family: 'Consolas', monospace;
  }
  :global(.tab.on) { background: #D97757; border-color: #D97757; color: #fff; }
  :global(.cb-close) {
    margin-left: auto;
    background: transparent;
    border: none;
    color: #9A968A;
    font-size: 13px;
    cursor: pointer;
    padding: 0 4px;
    border-radius: 4px;
  }
  :global(.cb-close:hover) { background: #F0EEE6; color: #1F1E1D; }
  :global(.cb-c) {
    flex: 1;
    margin: 0;
    padding: 10px 12px;
    color: #3D3929;
    font-size: 11px;
    line-height: 1.5;
    font-family: 'Consolas', 'Courier New', monospace;
    white-space: pre-wrap;
    word-break: break-all;
  }
  /* 文件视图：框内滚轮看全文（细滚动条，悬停变明显） */
  :global(.cb.scrollable .cb-c) {
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: #C9C2B4 transparent;
  }
  :global(.cb.scrollable .cb-c::-webkit-scrollbar) { width: 6px; }
  :global(.cb.scrollable .cb-c::-webkit-scrollbar-thumb) { background: #C9C2B4; border-radius: 3px; }
  /* 可点符号加大点击区：11px 小字难点准 */
  :global(.tok, .fn, .mem, .var, .loc) {
    display: inline-block;
    padding: 1px 3px;
    margin: -1px -1px;
    border-radius: 3px;
    cursor: pointer;
  }
  :global(.tok) { text-decoration: underline dotted; }
  :global(.tok:hover) { background: rgba(217, 119, 87, 0.12); }
  :global(.fn) { color: #D97757; }
  :global(.fn:hover) { background: rgba(217, 119, 87, 0.12); }
  :global(.mem) { color: #0D9488; }
  :global(.mem:hover) { background: rgba(13, 148, 136, 0.12); }
  :global(.var) { color: #B45309; }
  :global(.var:hover) { background: rgba(180, 83, 9, 0.12); }
  :global(.loc) { color: #4F46E5; }
  :global(.loc:hover) { background: rgba(79, 70, 229, 0.12); }
  :global(.fndef) { font-weight: 600; }
  :global(.fndef.on) { background: #FFF3C4; border-radius: 3px; padding: 0 2px; }
</style>
