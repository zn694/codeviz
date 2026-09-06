// demo 数据：camera 项目的模块/类依赖结构
// header：类声明（头文件视图，默认展示；函数名可点击跳实现）
// impl：实现片段（cpp 视图）
// syntax 字段模拟 tree-sitter 解析器将来会提取的语法信号
const defs = {
  main: {
    label: 'main.cpp',
    syntax: { kind: 'function', runLike: true },
    header: `// main.cpp —— 程序入口（无头文件）
// 职责：组装核心层与 UI 层，启动事件循环
int main(int argc, char* argv[]);`,
    impl: `int main(int argc, char* argv[])
{
    QApplication app(argc, argv);
    applyDarkTheme(app);

    // 日志：exe 旁 logs/ 目录
    Log::init(QCoreApplication::applicationDirPath().toStdString() + "/logs");

    // 枚举 + 创建 + 注入
    CameraFactory::setConfigDir(...);
    auto devices = CameraFactory::enumerateDevices();
    if (devices.empty()) { ...; return 1; }

    std::vector<std::unique_ptr<CameraInterface>> cameras;
    for (const auto& d : devices)
        cameras.push_back(CameraFactory::createCamera(d.serialNumber));
    CameraContext::initialize(std::move(cameras));
    CameraContext& ctx = CameraContext::instance();

    // CLI 模式：camera.exe --cli
    if (argc > 1 && std::string(argv[1]) == "--cli") { ... }

    // 观察者 + 主窗口
    ListenerManager listenerMgr;
    CameraImageQueue queue(2);
    ListenerBridge bridge;
    listenerMgr.registerListener(&bridge);
    MainWindow win(ctx, queue, listenerMgr, bridge, std::move(serials));
    win.show();
    return app.exec();
}`,
  },
  factory: {
    label: 'CameraFactory',
    syntax: { kind: 'class', allStatic: true, instantiated: false },
    header: `// 工厂：枚举/创建两条产线（静态方法类，从不实例化）
class CameraFactory {
public:
    static void setConfigDir(const std::string& dir);
    static std::vector<DeviceInfo> enumerateDevices();
    static std::unique_ptr<CameraInterface> createCamera(const std::string& serial);
};`,
    impl: `void CameraFactory::setConfigDir(const std::string& dir) {
    gConfigDir = dir;
}

std::vector<DeviceInfo> CameraFactory::enumerateDevices() {
#ifdef HAVE_MVS
    mvsSdk();                       // 触发 SDK 进程级初始化
    gMvsDevicesBySerial.clear();
    MV_CC_DEVICE_INFO_LIST list{};
    const int rc = MV_CC_EnumDevices(MV_GIGE_DEVICE | MV_USB_DEVICE
                                     | MV_VIR_GIGE_DEVICE | MV_VIR_USB_DEVICE, &list);
    if (rc != MV_OK)
        throw CameraError(rc, "MVS 枚举设备失败");
    // ...每台设备填 DeviceInfo，按序列号缓存 SDK 结构
#else
    // 无 SDK：回退两台模拟设备（VSN-0001/0002）
#endif
}

std::unique_ptr<CameraInterface> CameraFactory::createCamera(const std::string& serial) {
#ifdef HAVE_MVS
    const auto it = gMvsDevicesBySerial.find(serial);
    if (it != gMvsDevicesBySerial.end())
        return std::make_unique<HikCamera>(serial, it->second, ...);
#endif
    if (serial.rfind("VSN-", 0) == 0)
        return std::make_unique<VirtualCamera>(serial);
    throw CameraError(-1, "无法为序列号创建相机: " + serial);
}`,
  },
  context: {
    label: 'CameraContext',
    syntax: { kind: 'class', hasState: true, hasContainer: true, singleton: true },
    header: `// 相机上下文：单例 + 相机池所有权 + 方法转发
class CameraContext {
public:
    static CameraContext& instance();
    static void initialize(std::vector<std::unique_ptr<CameraInterface>> cameras);
    void connectCamera();
    void disconnectCamera();
    void startAcquisition();
    void stopAcquisition();
    void setParam(const std::string& name, double value);
private:
    std::vector<std::unique_ptr<CameraInterface>> cameras_;
    CameraInterface* active_ = nullptr;  // 借用指针
};`,
    impl: `void CameraContext::initialize(std::vector<std::unique_ptr<CameraInterface>> cameras) {
    if (instance_)
        throw CameraError(-1, "CameraContext 已初始化");
    instance_ = std::unique_ptr<CameraContext>(new CameraContext(std::move(cameras)));
}

void CameraContext::setParam(const std::string& name, double value) {
    active_->setParam(name, value);   // 转发给当前相机（虚调用分发）
}`,
  },
  iface: {
    label: 'CameraInterface',
    syntax: { kind: 'class', pureVirtual: true, hasState: false, hasMethods: true },
    header: `// 相机抽象接口：定义相机插件契约（纯虚，零数据）
class CameraInterface {
public:
    virtual ~CameraInterface() = default;
    virtual void open() = 0;
    virtual void close() = 0;
    virtual bool grabFrame(ImageData& out, uint32_t timeoutMs = 1000) = 0;
    virtual void setParam(const std::string& name, double value) = 0;
    virtual DeviceInfo deviceInfo() const = 0;
};`,
    impl: `// 纯虚接口没有实现——所有方法由 HikCamera / VirtualCamera 提供。
// 上层只依赖本接口：换品牌只改工厂一处。`,
  },
  hik: {
    label: 'HikCamera',
    syntax: { kind: 'class', hasState: true, inherits: 'iface' },
    header: `// 海康相机：CameraInterface 的 MVS SDK 实现
class HikCamera : public CameraInterface {
public:
    HikCamera(std::string serial, MV_CC_DEVICE_INFO devInfo, std::string configFile);
    ~HikCamera() override;
    void open() override;
    void close() override;
    void setParam(const std::string& name, double value) override;
    double getParamFloat(const std::string& name) const override;
private:
    void* handle_ = nullptr;   // SDK 设备句柄（不透明句柄）
    bool open_ = false;
};`,
    impl: `void HikCamera::open() {
    if (open_) throw CameraError(-1, "设备已打开");
    check(MV_CC_CreateHandle(&handle_, &devInfo_), "CreateHandle");
    try {
        check(MV_CC_OpenDevice(handle_, MV_ACCESS_Exclusive, 0), "OpenDevice");
    } catch (...) {
        MV_CC_DestroyHandle(handle_);   // 不留半开状态
        handle_ = nullptr;
        throw;
    }
    open_ = true;
    Log::info("海康相机已打开: " + info_.serialNumber);
}`,
  },
  virt: {
    label: 'VirtualCamera',
    syntax: { kind: 'class', hasState: true, inherits: 'iface' },
    header: `// 虚拟相机：软件模拟实现（也是无 SDK 环境的测试替身）
class VirtualCamera : public CameraInterface {
public:
    explicit VirtualCamera(std::string serial = "");
    void open() override;
    bool grabFrame(ImageData& out, uint32_t timeoutMs = 1000) override;
    void setParam(const std::string& name, double value) override;
private:
    std::map<std::string, int64_t> intParams_;
    std::map<std::string, double> floatParams_;
    std::map<std::string, std::string> stringParams_;
};`,
    impl: `void VirtualCamera::open() {
    if (state_ != State::Closed)
        throw CameraError(-1, "设备已打开");
    openTime_ = steady_clock::now();
    state_ = State::Open;
}

void VirtualCamera::setParam(const std::string& name, double value) {
    floatParams_[name] = value;   // 参数值存在自己的 map 里（类即设备）
}`,
  },
  pump: {
    label: 'AcquireImageProcess',
    syntax: { kind: 'class', hasState: true, threaded: true, runLike: true },
    header: `// 图像采集线程（泵）：循环取帧塞进队列
class AcquireImageProcess {
public:
    AcquireImageProcess(CameraContext& ctx, CameraImageQueue& queue,
                        ListenerManager& listenerMgr);
    ~AcquireImageProcess();  // join 兜底
    void start();
    void stop();
private:
    void run();
    std::thread thread_;
    std::atomic<bool> running_ = false;
};`,
    impl: `void AcquireImageProcess::run() {
    while (running_) {
        ImageData frame;
        try {
            if (ctx_.grabFrame(frame, 500))
                queue_.push(std::move(frame));
        } catch (const std::exception& e) {
            listenerMgr_.notifyError(e.what());
            running_ = false;
        }
    }
}`,
  },
  queue: {
    label: 'CameraImageQueue',
    syntax: { kind: 'class', hasContainer: true },
    header: `// 帧队列：生产者/消费者缓冲
class CameraImageQueue {
public:
    explicit CameraImageQueue(size_t capacity);
    void push(ImageData frame);
    bool tryPop(ImageData& out, uint32_t timeoutMs);
};`,
    impl: `bool CameraImageQueue::tryPop(ImageData& out, uint32_t timeoutMs) {
    std::unique_lock lock(mtx_);
    if (!cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                      [this] { return !queue_.empty(); }))
        return false;
    out = std::move(queue_.front());
    queue_.pop_front();
    return true;
}`,
  },
  win: {
    label: 'MainWindow',
    syntax: { kind: 'class', hasState: true, runLike: true },
    header: `// 主窗口：按钮只负责"调用 CameraContext"，不碰业务细节
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(CameraContext& ctx, CameraImageQueue& queue,
                        ListenerManager& listenerMgr, ListenerBridge& bridge,
                        std::vector<std::string> serials, QWidget* parent = nullptr);
private slots:
    void openCamera();
    void startAcquisition();
    void switchCamera();
private:
    CameraContext& ctx_;
    std::unique_ptr<AcquireImageProcess> process_;
};`,
    impl: `void MainWindow::openCamera() {
    try {
        ctx_.connectCamera();        // 打开设备
        ctx_.startAcquisition();     // 相机出帧
        process_->start();           // 泵开始转
        paramWidget_->refreshFromCamera();
    } catch (const std::exception& e) {
        statusBar()->showMessage(QString("打开失败: ") + e.what());
    }
}`,
  },
  paramWidget: {
    label: 'ParamWidget',
    syntax: { kind: 'class', hasState: true },
    header: `// 参数面板：MVD 框架的 View 宿主
class ParamWidget : public QWidget {
    Q_OBJECT
public:
    explicit ParamWidget(CameraContext& ctx, QWidget* parent = nullptr);
    void loadParams(const std::string& jsonPath);
    void refreshFromCamera();
private:
    CameraParamModel* model_ = nullptr;
    CameraParamDelegate* delegate_ = nullptr;
    QTreeView* tree_ = nullptr;
};`,
    impl: `void ParamWidget::loadParams(const std::string& jsonPath) {
    // JSON 描述 → 动态控件（热插拔：改 config/*.json 不用重编译）
    model_->setParams(ParseUiJson::parseFile(jsonPath));
}`,
  },
  dialog: {
    label: 'AgentChatDialog',
    syntax: { kind: 'class', hasState: true },
    header: `// AI 聊天对话框：agentfw 的 Qt 宿主
class AgentChatDialog : public QDialog {
    Q_OBJECT
public:
    AgentChatDialog(CameraContext& ctx, const std::vector<ParamInfo>& params,
                    const std::string& settingsPath, const std::string& knowledgePath);
private slots:
    void sendRequest();
private:
    std::unique_ptr<AgentHost> host_;
};`,
    impl: `void AgentChatDialog::sendRequest() {
    sendBtn_->setEnabled(false);          // 主动禁用（防重入），UI 线程不阻塞
    host_->startAsync(text.toStdString(),
        [this](bool ok, const std::string& result) {
            QMetaObject::invokeMethod(this, ...);   // worker → 主线程桥接
        },
        [this](call, result) { ... });
}`,
  },
  host: {
    label: 'AgentHost',
    syntax: { kind: 'class', hasState: true, threaded: true },
    header: `// 门面：装配全部组件 + worker 线程外壳
class AgentHost {
public:
    AgentHost(CameraContext& ctx, const std::vector<ParamInfo>& params,
              const std::string& settingsPath, const std::string& knowledgePath);
    ~AgentHost();  // join 兜底
    void startAsync(const std::string& userInput, DoneFn done, ProgressFn progress = {});
    std::string runSync(const std::string& userInput);
private:
    std::unique_ptr<ILLMClient> llm_;
    ToolRegistry registry_;
    std::unique_ptr<AgentRuntime> runtime_;
    std::thread worker_;
};`,
    impl: `AgentHost::AgentHost(...) : cfg_(AgentConfig::load(settingsPath)) {
    knowledge_.load(knowledgePath);
    llm_ = cfg_.mock ? make_unique<MockLLMClient>()
                     : make_unique<DeepSeekLLMClient>(http_, cfg_);
    registerCameraTools(registry_, ctx_, params_);
    runtime_ = make_unique<AgentRuntime>(*llm_, registry_, knowledge_, cfg_);
}`,
  },
  runtime: {
    label: 'AgentRuntime',
    syntax: { kind: 'class', hasState: true, runLike: true },
    header: `// ReAct 循环引擎：有记忆、无线程、只认接口
class AgentRuntime {
public:
    AgentRuntime(ILLMClient& llm, IToolInvoker& tools,
                 IKnowledgeStore& knowledge, const AgentConfig& cfg);
    std::string run(const std::string& userInput, const ProgressFn& onProgress = {});
    void clearHistory();
private:
    std::vector<ChatMessage> history_;  // 跨 run 保留：多轮对话
};`,
    impl: `std::string AgentRuntime::run(const std::string& userInput, ...) {
    history_.push_back({MessageRole::User, userInput, {}, {}});
    for (int round = 0; round < cfg_.maxRounds; ++round) {
        ChatRequest request;
        request.messages = [system + 全量历史];   // LLM 无状态，每轮全量发
        request.tools = tools_.definitions();
        const auto response = llm_.chat(request);
        if (response.toolCalls.empty()) return response.content;
        for (const auto& call : response.toolCalls)
            history_.push_back({Tool, tools_.invoke(call), call.id});
    }
    throw CameraError(-1, "ReAct 循环达到最大轮数");
}`,
  },
  registry: {
    label: 'ToolRegistry',
    syntax: { kind: 'class', hasContainer: true, registerLike: true },
    header: `// 工具注册表：白名单 + 安检 + 分发（shared_mutex 读写锁）
class ToolRegistry : public IToolInvoker {
public:
    void registerTool(const ToolDefinition& def, ToolFn fn);
    ToolResult invoke(const ToolCall& call) override;
    std::vector<ToolDefinition> definitions() const override;
private:
    mutable std::shared_mutex mtx_;
    std::map<std::string, ToolDefinition> defs_;
    std::map<std::string, ToolFn> fns_;
};`,
    impl: `ToolResult ToolRegistry::invoke(const ToolCall& call) {
    ToolFn fn;
    {
        std::shared_lock lock(mtx_);          // 读锁只查表
        if (!defs_.count(call.name))
            return {false, "未知工具: " + call.name};
        fn = fns_[call.name];
    }                                         // 释放锁再执行（避免长持锁）
    validateArgs(def.parametersSchema, call.arguments);
    return fn(call.arguments);
}`,
  },
  illm: {
    label: 'ILLMClient',
    syntax: { kind: 'class', pureVirtual: true, hasState: false },
    header: `// LLM 通信契约：只负责"和大模型对话"
class ILLMClient {
public:
    virtual ~ILLMClient() = default;
    virtual ChatResponse chat(const ChatRequest& request) = 0;
};`,
    impl: `// 纯虚接口：由 DeepSeekLLMClient（真实）与 MockLLMClient（测试替身）实现。
// 一行 if 换实现（AgentHost 装配处）——接口可替换性的兑现。`,
  },
  deepseek: {
    label: 'DeepSeekLLMClient',
    syntax: { kind: 'class', inherits: 'illm' },
    header: `// OpenAI 兼容实现：框架类型 ↔ 线格式的转换全在这里
class DeepSeekLLMClient : public ILLMClient {
public:
    DeepSeekLLMClient(IHttpClient& http, const AgentConfig& cfg);
    ChatResponse chat(const ChatRequest& request) override;
private:
    IHttpClient& http_;
    AgentConfig cfg_;
};`,
    impl: `ChatResponse DeepSeekLLMClient::chat(const ChatRequest& request) {
    QJsonObject body;                    // messages/tools → OpenAI 请求体
    body["model"] = ...; body["temperature"] = 0;
    const auto response = http_.post(cfg_.baseUrl + "/chat/completions", ...);
    // choices[0].message.content / tool_calls → ChatResponse
}`,
  },
  mock: {
    label: 'MockLLMClient',
    syntax: { kind: 'class', inherits: 'illm' },
    header: `// 测试替身：不发网络，按脚本返回（settings.json "mock": true 启用）
class MockLLMClient : public ILLMClient {
public:
    ChatResponse chat(const ChatRequest& request) override;
private:
    int callCount_ = 0;
};`,
    impl: `ChatResponse MockLLMClient::chat(const ChatRequest&) {
    if (++callCount_ == 1)
        return { toolCalls: [set_param(ExposureTime=3000)] };
    return { content: "已完成（Mock 演示）" };
}`,
  },
  knowledge: {
    label: 'KnowledgeStore',
    syntax: { kind: 'class', pureVirtual: true, hasState: false },
    header: `// 知识检索契约（RAG 的 R）
class IKnowledgeStore {
public:
    virtual ~IKnowledgeStore() = default;
    virtual std::vector<std::string> search(const std::string& query, size_t topK) = 0;
};`,
    impl: `std::vector<std::string> InMemoryKnowledgeStore::search(const std::string& query, size_t topK) {
    // 关键词打分：中文段/英文词在 title+content 中出现 +1，取 top-K
    // （简化版 BM25；知识库变大后升级语义向量检索）
}`,
  },
  log: {
    label: 'Log',
    syntax: { kind: 'class', allStatic: true, instantiated: false },
    header: `// 日志封装：全项目唯一接触 spdlog 的地方
class Log {
public:
    static void init(const std::string& logDir);
    static void info(const std::string& msg);
    static void warn(const std::string& msg);
    static void error(const std::string& msg);
};`,
    impl: `void Log::init(const std::string& logDir) {
    // 日期文件名 + 5MB x 3 滚动 + 控制台双输出
    auto fileSink = std::make_shared<rotating_file_sink_mt>(name, 5*1024*1024, 3);
    g_logger = std::make_shared<spdlog::logger>("camera", sinks);
    g_logger->flush_on(spdlog::level::info);
}

void Log::error(const std::string& msg) {
    ensure();               // 未初始化时退化为仅控制台
    g_logger->error(msg);
}`,
  },
  listenerMgr: {
    label: 'ListenerManager',
    syntax: { kind: 'class', hasContainer: true, registerLike: true },
    header: `// 观察者管理器：注册/注销/广播（快照 + 锁外回调）
class ListenerManager {
public:
    void registerListener(Listener* listener);
    void unregisterListener(Listener* listener);
    void notifyError(const std::string& message) const;
private:
    mutable std::mutex mtx_;
    std::vector<Listener*> listeners_;
};`,
    impl: `void ListenerManager::notifyError(const std::string& message) const {
    Log::error(message);           // 全部错误路径在此汇聚：一处落日志
    std::vector<Listener*> snapshot;
    {
        std::lock_guard lock(mtx_);
        snapshot = listeners_;     // 快照后锁外回调，避免死锁
    }
    for (Listener* l : snapshot)
        l->onError(message);
}`,
  },
  bridge: {
    label: 'ListenerBridge',
    syntax: { kind: 'class', hasState: false },
    header: `// 桥接类：核心层回调 → Qt 信号（跨线程排队）
class ListenerBridge : public QObject, public Listener {
    Q_OBJECT
public:
    void onError(const std::string& message) override;
signals:
    void errorOccurred(const QString& message);
};`,
    impl: `void ListenerBridge::onError(const std::string& message) {
    emit errorOccurred(QString::fromStdString(message));
    // 只转发不加工：worker 线程 emit，Qt 自动排队到主线程
}`,
  },
  camerror: {
    label: 'CameraError',
    syntax: { kind: 'class', hasState: true, hasMethods: true },
    header: `// 相机异常：携带 SDK 原始错误码
class CameraError : public std::runtime_error {
public:
    CameraError(int code, const std::string& msg);
    int errorCode() const;
private:
    int errorCode_;
};`,
    impl: `CameraError::CameraError(int code, const std::string& msg)
    : std::runtime_error(msg), errorCode_(code) {}`,
  },
  devinfo: {
    label: 'DeviceInfo',
    syntax: { kind: 'struct', hasMethods: false },
    header: `// 设备信息：枚举到相机后展示给用户
struct DeviceInfo {
    std::string vendor;
    std::string modelName;
    std::string serialNumber;
    std::string configFile;
};`,
    impl: `// 纯数据结构：无方法，值语义，工厂枚举时填充`,
  },
  imgdata: {
    label: 'ImageData',
    syntax: { kind: 'struct', hasMethods: false },
    header: `// 图像帧数据：值语义，靠移动传递
struct ImageData {
    uint32_t width = 0;
    uint32_t height = 0;
    PixelFormat format = PixelFormat::Mono8;
    uint64_t frameId = 0;
    std::vector<uint8_t> data;
};`,
    impl: `// 纯数据结构：grabFrame 移动填入，调用方不关心释放`,
  },
  paraminfo: {
    label: 'ParamInfo',
    syntax: { kind: 'struct', hasMethods: false },
    header: `// 参数描述模型：JSON 解析后的产出
struct ParamInfo {
    std::string name;     // 显示名
    std::string key;      // setParam/getParam 用
    std::string type;     // "int"|"float"|"enum"|"bool"|"string"
    double min = 0, max = 0;
    std::vector<std::string> options;
    std::string unit, group;
};`,
    impl: `// 纯数据结构：UI 面板与工具校验共用同一份描述`,
  },
  parsejson: {
    label: 'ParseUiJson',
    syntax: { kind: 'class', allStatic: true, instantiated: false },
    header: `// UI 解析器：JSON 参数描述 → vector<ParamInfo>
class ParseUiJson {
public:
    static std::vector<ParamInfo> parseFile(const std::string& path);
};`,
    impl: `std::vector<ParamInfo> ParseUiJson::parseFile(const std::string& path) {
    QFile file(QString::fromStdString(path));
    if (!file.open(QIODevice::ReadOnly))
        throw CameraError(-1, "无法打开参数配置文件: " + path);
    const QJsonDocument doc = QJsonDocument::fromJson(file.readAll(), &parseError);
    // ...按字段填 ParamInfo
}`,
  },
  agentcfg: {
    label: 'AgentConfig',
    syntax: { kind: 'struct', hasMethods: true },
    header: `// 框架配置：settings.json → 结构体（环境变量优先）
struct AgentConfig {
    std::string apiKey;
    std::string baseUrl = "https://api.deepseek.com";
    std::string model = "deepseek-chat";
    int maxRounds = 8;
    bool mock = false;
    static AgentConfig load(const std::string& path);
};`,
    impl: `AgentConfig AgentConfig::load(const std::string& path) {
    // env 块读 key/baseUrl；真实环境变量优先（与 Claude Code 一致）
    if (const char* key = std::getenv("DEEPSEEK_API_KEY"); key && *key)
        cfg.apiKey = key;
    return cfg;
}`,
  },
};

// 每个节点定义的函数（demo 符号表：函数名 → 定义所在类，点击函数跳定义）
const methods = {
  main: ['main', 'applyDarkTheme'],
  factory: ['setConfigDir', 'enumerateDevices', 'createCamera'],
  context: ['initialize', 'instance', 'connectCamera', 'disconnectCamera',
            'startAcquisition', 'stopAcquisition', 'switchCamera', 'setParam',
            'getParamInt', 'getParamFloat', 'getParamString'],
  iface: ['open', 'close', 'isOpen', 'grabFrame', 'deviceInfo'],
  hik: ['open', 'close', 'isOpen', 'startGrabbing', 'stopGrabbing', 'grabFrame',
        'check', 'deviceInfo'],
  virt: ['open', 'close', 'isOpen', 'startGrabbing', 'stopGrabbing', 'grabFrame',
         'deviceInfo'],
  pump: ['start', 'stop', 'run'],
  queue: ['push', 'tryPop'],
  win: ['openCamera', 'startAcquisition', 'stopAcquisition', 'switchCamera',
        'refreshView', 'onError', 'updateCameraInfo'],
  paramWidget: ['loadParams', 'refreshFromCamera'],
  dialog: ['sendRequest', 'onDoneFromWorker', 'onProgressFromWorker'],
  host: ['startAsync', 'runSync', 'clearHistory', 'busy'],
  runtime: ['run', 'clearHistory'],
  registry: ['registerTool', 'invoke', 'definitions', 'validateArgs'],
  illm: ['chat'],
  deepseek: ['chat'],
  mock: ['chat'],
  knowledge: ['search'],
  log: ['init', 'info', 'warn', 'error'],
  listenerMgr: ['registerListener', 'unregisterListener', 'notifyError'],
  bridge: ['onError'],
  camerror: ['errorCode'],
  parsejson: ['parseFile'],
  agentcfg: ['load'],
};
const functionOwners = {};
for (const [id, fns] of Object.entries(methods))
  for (const f of fns)
    (functionOwners[f] ||= []).push(id);

const nodes = Object.entries(defs).map(([id, d]) => ({
  id,
  data: { label: d.label },
  syntax: d.syntax,
  header: d.header,
  impl: d.impl,
}));

const edges = [
  ['main', 'factory'], ['main', 'context'], ['main', 'win'],
  ['factory', 'hik'], ['factory', 'virt'],
  ['context', 'iface'], ['hik', 'iface'], ['virt', 'iface'],
  ['win', 'pump'], ['pump', 'context'], ['pump', 'queue'],
  ['win', 'paramWidget'], ['paramWidget', 'context'],
  ['win', 'dialog'], ['dialog', 'host'],
  ['host', 'runtime'], ['host', 'registry'], ['host', 'knowledge'],
  ['runtime', 'illm'], ['runtime', 'registry'], ['runtime', 'knowledge'],
  ['illm', 'deepseek'], ['illm', 'mock'],
  ['registry', 'context'],
].map(([source, target]) => ({ source, target }));

export { nodes, edges, functionOwners };
