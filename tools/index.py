# index.py —— libclang 项目索引器
# 用法：python index.py <项目根目录> <输出.json>
# 产出：index.json = 全部源文件内容 + 类/函数/宏符号表 + 调用边
# 说明：无 compile_commands 时按 C++20 宽松解析（找不到的 include 自动恢复，
#       结构性信息——类/函数/成员/宏/调用关系——仍然完整提取）
import clang.cindex as ci
import json
import os
import sys

CLASS_KINDS = {
    ci.CursorKind.STRUCT_DECL, ci.CursorKind.CLASS_DECL,
    ci.CursorKind.UNION_DECL, ci.CursorKind.ENUM_DECL,
}
CALL_KINDS = {ci.CursorKind.CALL_EXPR}  # clang 新版成员调用统一为 CALL_EXPR


def loc(cursor):
    l = cursor.location
    return (l.file.name if l.file else '', l.line, cursor.extent.end.line)


def is_project_file(path, root):
    # 排除 vendored/构建目录：header-only 库（如 fmt）的定义会随 include 被
    # walk 到，若不加过滤会被误收为项目符号
    p = os.path.abspath(path).replace('\\', '/')
    r = root.replace('\\', '/')
    return p.startswith(r) and '/third_party/' not in p and '/out/' not in p


def find_compile_db(root):
    # 找任意 out/build/*/compile_commands.json（CMake 导出）
    for dirpath, dirnames, names in os.walk(root):
        if 'compile_commands.json' in names:
            return ci.CompilationDatabase.fromDirectory(dirpath)
    return None


def to_clang_args(cmd_args):
    # compile_commands 里是 cl.exe（MSVC）参数：只提取 include 路径与宏定义，
    # 转成 clang 格式（libclang 不认 /MDd 等 MSVC 旗标）
    out = ['-x', 'c++', '-std=c++20']
    for a in cmd_args:
        if a.startswith('/external:I'):
            out.append('-isystem' + a[len('/external:I'):])
        elif a.startswith(('/I', '-I')):
            out.append('-I' + a[2:])
        elif a.startswith(('/D', '-D')):
            out.append('-D' + a[2:])
    return out


def main(root, out_path):
    root = os.path.abspath(root)
    files = []
    for dirpath, dirnames, names in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in ('out', 'build', '.git', 'third_party', 'node_modules', 'sample')]
        for n in names:
            if n.endswith(('.cpp', '.h', '.hpp', '.cc', '.cxx')):
                files.append(os.path.join(dirpath, n))

    # compile_commands.json 决定解析精度：没有时类型解析失败会导致调用边缺失
    db = find_compile_db(root)
    print('compile_commands.json:', '已找到，按构建参数解析' if db else '未找到，按通用参数解析（调用边可能不全）')

    contents = {}
    cls_map = {}      # name -> {decl 信息, methods[], members[]}
    functions = []
    macros = []
    variables = []
    fn_keys = set()
    edges = []
    edge_set = set()

    def add_edge(frm, to):
        if frm == to or (frm, to) in edge_set:
            return
        edge_set.add((frm, to))
        edges.append([frm, to])

    def ensure_class(name):
        return cls_map.setdefault(name, {'name': name, 'file': '', 'line': 0, 'endLine': 0,
                                         'base': '', 'methods': [], 'members': []})

    def collect_calls(body, from_key):
        for c in body.walk_preorder():
            if c.kind not in CALL_KINDS:
                continue
            ref = c.referenced
            if ref is None:
                continue
            if not is_project_file(loc(ref)[0], root):
                continue
            k = ref.kind
            if k == ci.CursorKind.CONSTRUCTOR or k == ci.CursorKind.DESTRUCTOR:
                p = ref.semantic_parent
                if p is not None and p.kind in CLASS_KINDS and p.spelling:
                    add_edge(from_key, 'cls:' + p.spelling)
                continue
            if k in (ci.CursorKind.CXX_METHOD, ci.CursorKind.FUNCTION_DECL,
                     ci.CursorKind.FUNCTION_TEMPLATE):
                p = ref.semantic_parent
                if p is not None and p.kind in CLASS_KINDS and p.spelling:
                    add_edge(from_key, 'cls:' + p.spelling)
                else:
                    add_edge(from_key, 'fn:' + ref.spelling)
                continue
            if k in CLASS_KINDS:
                add_edge(from_key, 'cls:' + ref.spelling)

    idx = ci.Index.create()
    for f in files:
        rel = os.path.relpath(f, root).replace('\\', '/')
        try:
            with open(f, 'r', encoding='utf-8', errors='replace') as fh:
                contents[rel] = fh.read()
        except OSError:
            continue
        args = ['-x', 'c++', '-std=c++20']
        if db:
            cms = db.getCompileCommands(f)
            if cms:
                cmd_args = list(cms[0].arguments)
                if cmd_args and len(cmd_args) > 1:
                    args = to_clang_args(cmd_args[1:])  # 去掉编译器名 + MSVC→clang 转换
        try:
            tu = idx.parse(f, args=args,
                           options=ci.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD)
        except ci.TranslationUnitLoadError:
            # 个别文件构建参数解析失败：回退通用参数
            tu = idx.parse(f, args=['-x', 'c++', '-std=c++20'],
                           options=ci.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD)
        for c in tu.cursor.walk_preorder():
            k = c.kind
            name = c.spelling
            fname, line, end = loc(c)
            if not name or not is_project_file(fname, root):
                continue

            # 类/结构体声明：只收有定义的（前向声明如 class QTimer; 跳过）
            if k in CLASS_KINDS:
                if name.startswith('('):  # lambda 伪类，跳过
                    continue
                if not c.is_definition():
                    continue
                entry = ensure_class(name)
                if not entry['file'] or len(contents.get(os.path.relpath(fname, root).replace('\\', '/'), '')) > 0:
                    entry['file'] = os.path.relpath(fname, root).replace('\\', '/')
                    entry['line'] = line
                    entry['endLine'] = end
                for ch in c.get_children():
                    if ch.kind == ci.CursorKind.CXX_BASE_SPECIFIER:
                        b = ch.type.spelling
                        entry['base'] = b.split('::')[-1].split('<')[0]
                    elif ch.kind == ci.CursorKind.FIELD_DECL and ch.spelling:
                        # 跳过匿名字段（Q_OBJECT 宏展开会产空名 FIELD_DECL）
                        if not any(m['name'] == ch.spelling for m in entry['members']):
                            entry['members'].append({'name': ch.spelling,
                                                     'line': loc(ch)[1],
                                                     'endLine': loc(ch)[2],
                                                     'file': os.path.relpath(fname, root).replace('\\', '/')})
                continue

            # 方法定义（.cpp 里）：挂回所属类 + 扫描调用
            if k == ci.CursorKind.CXX_METHOD and c.is_definition():
                parent = c.semantic_parent
                if parent is not None and parent.kind in CLASS_KINDS and parent.spelling:
                    entry = ensure_class(parent.spelling)
                    entry['methods'].append({
                        'name': name,
                        'file': os.path.relpath(fname, root).replace('\\', '/'),
                        'line': line, 'endLine': end,
                    })
                    collect_calls(c, 'cls:' + parent.spelling)
                continue

            # 自由函数：只收有定义的 + 扫描调用
            if k == ci.CursorKind.FUNCTION_DECL and name not in fn_keys and c.is_definition():
                fn_keys.add(name)
                functions.append({'name': name,
                                  'file': os.path.relpath(fname, root).replace('\\', '/'),
                                  'line': line, 'endLine': end})
                collect_calls(c, 'fn:' + name)
                continue

            if k == ci.CursorKind.MACRO_DEFINITION:
                macros.append({'name': name,
                               'file': os.path.relpath(fname, root).replace('\\', '/'),
                               'line': line})

            # 变量：全局（owner=''）/ 局部（owner=所在函数）都可点击跳声明
            if k == ci.CursorKind.VAR_DECL:
                p = c.semantic_parent
                if p is not None and p.kind in (ci.CursorKind.TRANSLATION_UNIT,
                                                ci.CursorKind.NAMESPACE,
                                                ci.CursorKind.FUNCTION_DECL,
                                                ci.CursorKind.CXX_METHOD,
                                                ci.CursorKind.FUNCTION_TEMPLATE):
                    variables.append({'name': name,
                                      'file': os.path.relpath(fname, root).replace('\\', '/'),
                                      'line': line, 'endLine': end,
                                      'owner': p.spelling if p.kind not in (
                                          ci.CursorKind.TRANSLATION_UNIT,
                                          ci.CursorKind.NAMESPACE) else ''})
            # 函数参数：同局部变量处理
            if k == ci.CursorKind.PARM_DECL:
                p = c.semantic_parent
                if p is not None and p.kind in (ci.CursorKind.FUNCTION_DECL,
                                                ci.CursorKind.CXX_METHOD,
                                                ci.CursorKind.FUNCTION_TEMPLATE):
                    variables.append({'name': name,
                                      'file': os.path.relpath(fname, root).replace('\\', '/'),
                                      'line': line, 'endLine': end,
                                      'owner': p.spelling})

    classes = [cls_map[n] for n in sorted(cls_map)]
    result = {'root': root, 'files': contents, 'classes': classes,
              'functions': functions, 'macros': macros, 'variables': variables,
              'edges': edges}
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print(f'OK: {len(files)} 文件, {len(classes)} 类, {len(functions)} 函数, '
          f'{len(macros)} 宏, {len(edges)} 调用边 -> {out_path}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'index.json')
