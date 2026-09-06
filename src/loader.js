// loader.js —— index.json → 可视化图数据
// 方块 = 类（声明=头文件视图，方法定义=实现视图）与自由函数
// 宏暂不建方块（使用处不可点 → 无入口；定义处留待阶段 2 细化）
export function buildGraph(index) {
  const files = index.files;
  const slice = (path, from, to) => {
    const text = files[path];
    if (!text) return '';
    const lines = text.split('\n');
    return lines.slice(Math.max(0, from - 1), Math.max(from, to)).join('\n');
  };

  const nodes = [];
  const labelOwners = {};      // 名字 -> [节点 id]（重名/重载候选列表用）
  const register = (name, id) => (labelOwners[name] ||= []).push(id);

  for (const c of index.classes) {
    const header = slice(c.file, c.line, c.endLine);
    const impl = c.methods
      .map((m) => `// ${m.file}:${m.line}\n` + slice(m.file, m.line, m.endLine))
      .join('\n\n');
    const syntax = {
      kind: 'class',
      pureVirtual: c.methods.length === 0 && /=\s*0\s*;/.test(header),  // 纯虚接口
      hasState: c.members.length > 0,
      inherits: c.base || undefined,
      hasMethods: /\(/.test(header),
      hasContainer: c.members.length > 0 && /vector|map|list|set|queue|deque/i.test(header),
      singleton: /static\s+\w+\s*&\s*instance\s*\(/.test(header),
      registerLike: /register|add|remove/i.test(header),
      threaded: /thread/i.test(header),
      runLike: /\brun\b|\bstart\b|\bstop\b|loop/i.test(header),
    };
    const id = 'cls:' + c.name;
    nodes.push({ id, data: { label: c.name }, syntax, header, impl,
                 memberData: c.members, methodData: c.methods });
    register(c.name, id);
  }

  for (const f of index.functions) {
    const text = slice(f.file, f.line, f.endLine);
    const id = 'fn:' + f.name;
    nodes.push({
      id,
      data: { label: f.name },
      syntax: { kind: 'function', runLike: true },
      header: `// ${f.file}:${f.line}\n` + text,
      impl: text,
    });
    register(f.name, id);
  }

  // 函数名 → 定义所在节点（重载 = 多个候选）
  const functionOwners = {};
  for (const c of index.classes)
    for (const m of c.methods)
      (functionOwners[m.name] ||= []).push('cls:' + c.name);
  for (const f of index.functions)
    (functionOwners[f.name] ||= []).push('fn:' + f.name);

  const validIds = new Set(nodes.map((n) => n.id));
  const edges = index.edges
    .filter(([a, b]) => validIds.has(a) && validIds.has(b))
    .map(([source, target]) => ({ source, target }));

  const entry = validIds.has('fn:main') ? 'fn:main'
              : (edges[0]?.source || nodes[0]?.id);

  // 变量：全局（名字 → 声明）；局部/参数（名字 → [带 owner 的声明]）
  const variables = {};
  const locals = {};
  for (const v of index.variables || []) {
    if (!v.owner) {
      if (!(v.name in variables)) variables[v.name] = v;
    } else {
      const list = (locals[v.name] ||= []);
      // 去重：同一 (owner, name) 会因多个 TU 解析头文件而重复
      if (!list.some((x) => x.owner === v.owner)) list.push(v);
    }
  }

  return { nodes, edges, functionOwners, labelOwners, entry, files: index.files,
           variables, locals };
}
