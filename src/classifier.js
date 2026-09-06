// classifier.js —— 类角色规则分类器（不用 LLM）
// 输入：语法信号（模拟 tree-sitter 提取的字段）+ 图论信号（依赖度数）
// 输出：每节点 { role, confidence }
// 规则 = 语法特征 + 命名约定 + 图论特征 三类信号打分，取最高分角色

export const ROLES = {
  flow:      { label: '流程类', color: '#3E7D4F' },
  interface: { label: '接口类', color: '#2563EB' },
  impl:      { label: '实现类', color: '#C2410C' },
  tool:      { label: '工具类', color: '#B45309' },
  manager:   { label: '管理类', color: '#7C3AED' },
  data:      { label: '数据结构', color: '#6B7280' },
  bridge:    { label: '桥接类', color: '#0D9488' },
};

function add(score, role, cond, points) {
  if (cond) score[role] = (score[role] || 0) + points;
}

export function classifyNodes(nodes, edges) {
  // 图论：入度/出度
  const inDeg = {}, outDeg = {};
  for (const n of nodes) { inDeg[n.id] = 0; outDeg[n.id] = 0; }
  for (const e of edges) { outDeg[e.source]++; inDeg[e.target]++; }

  // 第一遍：纯语法打分
  const first = nodes.map((n) => {
    const s = n.syntax || {};
    const score = {};

    // 接口：纯虚 + 无状态
    add(score, 'interface', s.pureVirtual && !s.hasState, 3);
    // 实现：继承某个类（第二遍确认基类是接口再加分）
    add(score, 'impl', !!s.inherits, 1);
    // 工具：全静态方法 + 从不实例化
    add(score, 'tool', s.allStatic && !s.instantiated, 3);
    add(score, 'tool', /Factory|Util|Helper|Parser/.test(n.label), 2);
    // 管理：容器成员 +（单例 或 register/add/remove 形态）
    add(score, 'manager', s.hasContainer && (s.singleton || s.registerLike), 3);
    add(score, 'manager', /Manager|Registry|Context|Store|Queue/.test(n.label), 2);
    // 流程：有状态 +（线程 或 run/start/stop 形态）
    add(score, 'flow', s.hasState && (s.threaded || s.runLike), 3);
    add(score, 'flow', /Window|Widget|Dialog|Host|Runtime|Process/.test(n.label), 2);
    add(score, 'flow', n.id === 'main', 3);  // 入口天然是流程
    // 桥接：命名约定
    add(score, 'bridge', /Bridge|Adapter/.test(n.label), 3);
    // 数据结构：struct + 无方法
    add(score, 'data', s.kind === 'struct' && !s.hasMethods, 3);

    // 图论：接口 = 被很多人依赖、几乎不依赖别人
    add(score, 'interface', inDeg[n.id] >= 3 && outDeg[n.id] === 0, 2);
    // 流程 = 调用别人最多（主干）
    add(score, 'flow', outDeg[n.id] >= 4, 2);
    // 工具 = 被调用多、调用少
    add(score, 'tool', inDeg[n.id] >= 2 && outDeg[n.id] <= 1, 1);

    let best = 'data', bestScore = 0;
    for (const [role, pts] of Object.entries(score)) {
      if (pts > bestScore) { best = role; bestScore = pts; }
    }
    const total = Object.values(score).reduce((a, b) => a + b, 0);
    return { id: n.id, role: best, confidence: total ? bestScore / total : 0 };
  });

  // 第二遍：基类是接口 → 实现类加分重判
  const byId = Object.fromEntries(first.map((r) => [r.id, r]));
  return nodes.map((n) => {
    const r = { ...byId[n.id] };
    const base = n.syntax?.inherits;
    if (base && byId[base]?.role === 'interface') {
      r.role = 'impl';
      r.confidence = Math.max(r.confidence, 0.85);
    }
    return r;
  });
}
