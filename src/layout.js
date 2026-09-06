// layout.js —— 主干+卫星布局
// ① 主干：流程类按调用链拓扑排序，沿水平主线排开（分支给纵向偏移）
// ② 卫星：非流程类（接口/工具/管理/实现…）吸附到"锚点"（调用它的流程类）旁，
//         按组扇形排布在锚点上下两侧
export function computeLayout(nodes, edges, roles) {
  const roleOf = Object.fromEntries(roles.map((r) => [r.id, r.role]));
  const isFlow = (id) => roleOf[id] === 'flow';

  const flowIds = nodes.filter((n) => isFlow(n.id)).map((n) => n.id);
  const pos = {};
  const SPINE_X = 220, SPINE_Y = 300, GAP = 200;

  // ① 主干：按边做拓扑序（简单版：BFS 从 main 出发，未被连到的流程节点按原名排列）
  const order = [];
  const visited = new Set();
  const queue = flowIds.includes('main') ? ['main'] : [flowIds[0]];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    for (const e of edges) {
      if (e.source === id && isFlow(e.target) && !visited.has(e.target))
        queue.push(e.target);
    }
  }
  for (const id of flowIds) if (!visited.has(id)) order.push(id);

  // 主干节点：x 递增；与前一节点无直接边的视为"分支"，给纵向偏移
  const branchOffset = {};
  let branch = 0;
  order.forEach((id, i) => {
    const prev = order[i - 1];
    const directlyConnected = prev !== undefined &&
      edges.some((e) => e.source === prev && e.target === id);
    if (prev !== undefined && !directlyConnected) branch++;
    branchOffset[id] = branch;
    pos[id] = { x: SPINE_X + i * GAP, y: SPINE_Y + branch * 70 };
  });

  // ② 卫星：找锚点。两遍搜索——先找流程/管理类做锚（主干挂靠），
  //    再放宽到任意有边相连的节点（如实现类挂在接口旁）
  const isAnchorType = (id) => {
    const r = roleOf[id];
    return r === 'flow' || r === 'manager';
  };
  const satellites = nodes.filter((n) => !isFlow(n.id));
  const groups = new Map(); // anchorId -> [satelliteId]
  const findAnchor = (id, strict) => {
    for (const e of edges) {
      if (e.source === id && (strict ? isAnchorType(e.target) : true)) return e.target;
      if (e.target === id && (strict ? isAnchorType(e.source) : true)) return e.source;
    }
    return null;
  };
  for (const n of satellites) {
    let anchor = findAnchor(n.id, true) || findAnchor(n.id, false) || 'main';
    if (!groups.has(anchor)) groups.set(anchor, []);
    groups.get(anchor).push(n.id);
  }

  // 卫星：围绕锚点上下扇形排
  for (const [anchor, ids] of groups) {
    const ax = pos[anchor].x, ay = pos[anchor].y;
    const R = 150;
    ids.forEach((id, i) => {
      const side = i % 2 === 0 ? 1 : -1;                 // 交替上下
      const row = Math.floor(i / 2);
      const angle = (side > 0 ? -1 : 1) * (0.5 + row * 0.45);  // 扇形角
      pos[id] = {
        x: ax + Math.sin(angle) * R * (side > 0 ? -1 : 1) * 1.2 + (side > 0 ? 0 : 0),
        y: ay + side * R * Math.cos(angle) + row * 40,
      };
    });
  }

  return pos;
}
