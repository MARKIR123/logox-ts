# 使用 LOGOX TS

本页说明正式入口的配置、命令和文件操作。界面操作见 [UI-SPEC](UI-SPEC.md)，验收步骤见 [TESTING](development/TESTING.md)。

## 配置模型

先配云端，再配本地。模型查询和生成请求使用同一份认证；配置示例见 [config.example.toml](../config.example.toml)。

### 云端登录

启动后在输入区输入 /login，按 ↑↓ 选择提供商、Enter 继续，然后输入或粘贴 API key，Enter 保存。也可以直接输入 /login deepseek。

登录区会临时替换普通输入区。选中项使用 ❯ 与 LOGOX 高亮色；密钥显示为遮罩。Esc 取消未提交的输入；保存完成或取消后回到对话，原来的草稿保留。Ctrl+C 统一用于复制或双击退出。

凭据保存在用户目录 ~/.logox/auth.json，例如 C:/Users/Administrator/.logox/auth.json。重新打开对话或切换项目时自动读取，不需要再次输入；重新 /login 同一提供商可更新密钥。认证文件与聊天账本分开，密钥不进入消息、模型正文、日志或项目配置。保存成功只表示密钥已落盘，接口连接可用 /check-provider 检查。

当前开发机默认选择 deepseek-flash；默认配置已移除借用 pi 的 auth_file，首次使用请自己完成 /login。输入 /model 打开已登录提供商的统一模型列表，也可以用 /model 名称直接选择当前提供商的模型。登录后切到该提供商；若尚无模型则提示选择。提供商和模型选择重启仍以配置为准，已保存的 API key 保留。

```powershell
npm run build
npm start
```

在舞台中依次输入 /login、选择并保存密钥，再用 /check-provider 验证。重启后也可直接运行 npm start -- --check-provider；它真正请求模型并确认完整回复。--check-config 只检查选择与认证是否存在；--list-providers / --list-models 查询提供商和模型。

### 认证的后备来源

登录保存的 LOGOX 凭据优先，其次是 api_key_env 指定的环境变量，最后是显式 auth_file 指定的只读 pi API key 文件。普通用户只需 /login；环境与外部文件用于已有自动化或迁移配置，不自动复制 pi 密钥。

可选 auth_file 支持 pi 的 api_key 记录、原始密钥与完整 $ENV / ${ENV} 引用，每次请求重新读取。OAuth、!命令取密钥和混合模板尚未支持。没有保存的凭据时也可提供 DEEPSEEK_API_KEY；--auth-file 可临时指定后备文件。示例见 [config.example.toml](../config.example.toml)。

### 网络与代理

模型生成、Actor 和模型列表共用网络连接。LOGOX 自动读取启动终端的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`；小写非空变量优先。Clash 的系统代理开关不会自动创建这些变量，需要在同一终端设置，例如默认端口为 7897 时：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
npm start
```

端口以自己的 Clash 设置为准。代理地址支持 HTTP(S)，`NO_PROXY` 指定绕过代理的地址；不设置代理变量时直连。网络连接按 PI 配置 HTTP/1.1、连接池和 5 分钟数据空闲期限；模型无有效进展的超时仍使用 `provider.timeout`，默认 120 秒，心跳不刷新它。

连接重置、断流或无进展超时会先有限重试，界面显示原因与次数。重试保留已完成工具结果，不执行半截工具调用，失败输出保存在历史中但不拼入下一次模型请求。同一根任务同一故障最多自动补救两次，随后停止自动续做；用户停止、认证/额度和协议错误各按原规则处理。修改源码后先 `npm run build`，重新启动才使用新网络实现。

### 接口与分层配置

| name | 协议 | 默认地址 | 密钥环境变量 |
|---|---|---|---|
| deepseek | OpenAI 兼容 | https://api.deepseek.com | DEEPSEEK_API_KEY |
| openai-compatible | OpenAI 兼容 | https://api.openai.com/v1 | OPENAI_API_KEY |
| anthropic | Anthropic 原生 | https://api.anthropic.com/v1 | ANTHROPIC_API_KEY |
| ollama | OpenAI 兼容 | http://127.0.0.1:11434/v1 | 不需要 |
| lm-studio | OpenAI 兼容 | http://127.0.0.1:1234/v1 | 不需要 |

只有 DeepSeek 已在本机通过真实云端验收；Google 原生协议和 OAuth 未接入。

加载顺序：默认值 → 用户 ~/.logox/config.toml → 工作目录各层祖先项目的 .logox/config.toml（由远到近）→ 项目上次模型选择 → LOGOX__ 环境变量 → CLI。字段合并，同一物理文件只加载一次。改换 provider.name 会清除上一家的模型、地址与认证选择，保留 temperature/max_tokens/timeout/thinking_effort；新提供商从自己的定义或预设取值。同一覆盖层的结果不受字段排列顺序影响。

自定义服务使用 [providers.work] 配置 kind、base_url、api_key_env、可选 auth_file/auth_provider/default_model，再选择 [provider] name="work"。provider.base_url、api_key_env、auth_file、auth_provider、kind 可以覆盖所选定义；auth_provider 指定认证文件中的名称，默认与提供商名称相同。URL 不包含用户名、密码、查询参数或片段。

provider.timeout 是连续没有有效模型进展的超时秒数（默认 120 秒），从发送请求开始计时；正文、思考和工具参数等有效数据刷新期限，持续输出没有总时长限制，空帧与心跳不刷新。max_tokens 是输出上限。kernel.max_iterations 是任务的模型往返额度，到达后询问续做；max_retries 只在尚无可见增量时重试暂时连接错误。Actor 真正超时后交给 Logox，优先指派原 Actor 从已有摘要、工具结果和中断输出续做，同一故障最多自动补救两次。环境变量例如 LOGOX__PROVIDER__MODEL、LOGOX__KERNEL__MAX_ITERATIONS，CLI 支持 --provider、--model、--base-url。

### 本地服务

当前开发机已停用 LOGOX 的 Ollama 配置，用户默认使用 DeepSeek / deepseek-flash；新目录没有项目覆盖时也使用这个选择，认证继续读取用户目录的已保存凭据。`/model` 不再查询 Ollama。

以下为以后启用本地服务时的配置方法。此前 logox-qwen3.8:27b 别名（共享原 qwen3.8:27b 权重，8192 上下文）已通过自然语言与隔离 read 工具闭环。先启动服务并配置所需模型，再显式切换：

```powershell
npm start -- --provider ollama --check-provider
npm start -- --provider ollama
```

舞台内输入 /provider ollama 使用项目配置的 default_model；/provider deepseek 切回云端；/provider antigravity 切至本地 Antigravity Tools 反代（`http://127.0.0.1:8045/v1`，无需 API Key，自动支持 100 万 Token 窗口与多模态）。若服务未运行，先在另一个终端执行对应服务。LOGOX 不会自动拉取模型或启动服务。

别的机器可以用自己已有模型执行 --provider ollama --model 实际名称 --check-provider。原 qwen3.8:27b 固定的 num_ctx=98304 在本机未通过，服务环境变量没有覆盖模型参数。本机用以下 Modelfile 新建别名，原模型保持不变：

```text
FROM qwen3.8:27b
PARAMETER num_ctx 8192
```

保存后运行 ollama create logox-qwen3.8:27b -f 文件路径；项目 [providers.ollama] 设置 kind="openai_compat"、base_url="http://127.0.0.1:11434/v1"、default_model="logox-qwen3.8:27b"。8192 是本轮小任务的已验收配置；长对话预算与压缩已接入，实际服务的长任务验收仍待完成；在 [models."ollama/logox-qwen3.8:27b"] 中填写 context_window=8192，使用服务实际配置的窗口。上下文设置方法见 [Ollama 文档](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)。

## 任务与命令

正式舞台输入 `/` 即显示命令与用途，继续键入按前缀过滤。↑↓ 选择，Tab 补齐，Enter 确认；可无参数执行的命令会直接执行或打开界面；/cast 等必填参数命令先留在输入区。参数候选按 Enter 只补齐，再按 Enter 提交。Esc 收起菜单并保留草稿，编辑后再次联想；Shift/Alt+Enter 仍换行。无候选时 Tab 仍聚焦审批或提问。

`/login ` 与 `/provider ` 可联想已配置的提供商；`/model ` 联想当前模型、已查询模型及“提供商/模型”目录候选。切换提供商后候选同步更新。键入时只筛选本地候选；打开 `/model` 才刷新已认证云端及已配置本地接口的模型目录，`/models` 仍只查询当前提供商。登录密钥区与自由回答区不显示命令菜单。

直接输入任务由 Logox 执行；用 `@aletheia`、`@techne`、`@kalon` 后接任务可直接派发。角色窗口中的普通输入交给当前角色。每个角色维护独立历史，多项任务串行登场。

Logox 可以调用 `dispatch_role` 派发任务。它先结束当前回合，让排队角色登场；全部结果返回后自动继续核对原任务。每条协作链最多三次派发往返，避免在同一队列里等待自己。

输入 `/actors` 查看每个角色的职能、人设、摘要重点、保留参数和默认模型；`/actors model techne` 为 Techne 选择默认模型，候选与 `/model` 相同，取消不保存。未指定的角色继承当前会话模型。默认模型不可用时卡片展开询问，确认后只在本任务转用当前会话模型，已完成工具不重复执行。

角色完成卡片收起显示一句话标题，展开看简短报告和完整流程。Aletheia、Techne、Kalon 每任务结束整理：保留零个完整旧轮，最近工具分别保留 2、2、0 次。原账本保留；用户直接 @角色只给 Logox 留下可查阅的索引，详细成果按需读取。

自定义角色放在用户 `~/.logox/actors/` 或项目 `.logox/actors/` 的 Markdown 文件中，格式见[角色模块](modules/actors.md)。修改后空闲时 `/reload`；项目定义优先，坏文件保留上一份有效目录。Logox 可提交 craft_actor 塑造方案，必须批准展示的文件和完整正文才保存。角色协作须先申请、由 Logox 批准，双方最多三轮往返。

| 命令 | 用途 |
|---|---|
| /help | 打开页签页面的“命令”页 |
| /login [提供商] | 选择提供商、输入并保存 API key，重启自动读取 |
| /providers | 打开提供商选择器，与 /provider 相同 |
| /provider [名称] [模型] | 无参数打开选择器；带参数切换提供商，未给模型时使用其 default_model |
| /check-provider | 请求真实模型，验证完整回复 |
| /status | 打开页签页面的“状态”页，查看模型、会话与活动任务数 |
| /config | 打开“配置”页，查看当前生效参数 |
| /effort [档位] | 选择当前模型支持的思考档位；/thinking、/think 为别名 |
| /usage | 查看当前角色任务/汇总用量、缓存与静态费用 |
| /models | 查询当前服务的模型列表 |
| /model [提供商/模型] | 无参数打开统一模型选择器；带名称切换模型，可指定提供商 |
| /cast 任务 | 把同一任务交给三个角色，串行执行 |
| /actors [model 角色] | 查看剧团；为指定 Actor 选择默认模型 |
| /compact | 扬弃：整理当前窗口角色的上下文，保留原始账本 |
| /new | 创建并切换新会话 |
| /resume [会话 ID] | 选择当前项目历史，或按 ID 恢复 |
| /clear | 清空当前对话显示，保留模型上下文、账本与文件 |
| /rewind | 选择轮次，回退该轮及之后的对话和受支持文件修改 |
| /undo | 只撤销当前会话最近一轮文件工具修改 |
| /reload | 空闲时重扫角色、人设、规范、技能与模板，分项报告配置校验 |
| /skills | 查看技能名称、描述与正文路径 |
| /commands | 查看内置和自定义模板命令 |

选择器支持键入搜索、↑↓、Home/End 和分页，Enter 确认；页签页面用 ←→ 或 Tab 切换，↑↓ 和分页浏览。Esc 返回原舞台并保留草稿与审批焦点，Ctrl+D 退出。取消选择不改变模型；命令页面不触发模型请求。

状态栏始终一行，默认显示角色、模型、思考强度、权限、上下文占用和运行状态。进入 `/status` 的“状态栏”页签，用 ↑↓ 选择、Space 切换 `[ ]` / `[■]`、←→ 调整顺序、Enter 保存、Esc 放弃；也可用鼠标。开关选中后文字高亮，靠前的模块在窄屏优先保留。累计 Token、费用、会话名和目录可选；布局保存在用户 `~/.logox-ts/statusbar.json`，各项目和角色共用布局、各自显示真实数据。

/status 的“动效”页签可关闭运行点阵、Thinking 流光与 Actor 呼吸，静态状态和耗时仍保留。每次 Thinking 在模型请求开始时出现，单独计时和估算 Tokens；工具与它同级，不包在累计思考卡里。点阵与流光使用所属角色主题色，正常结束显示灰色 `▮ Thought for … · … Tokens`，错误中断方块红色。工具固定前置 ▮，正常淡灰、异常红色；只显示名称、关键参数和自身耗时，权限拒绝追加红色粗体 Denied，执行失败追加 Error。等待不计执行耗时。内联标题默认浅灰，悬停使用角色主题色。Actor 工作时外层卡片轻微呼吸，等待和结束停止；内层灰底稳定，自动压缩通知归所属任务卡。

复杂任务由模型显式维护阶段。阶段标题顶格、主题色加粗、段前空一行，无前缀和机械进度；Thinking 与工具向内缩进两列。阶段不折叠，具体步骤仍可展开。Actor 收起标题说明当前自然动作，展开显示完整原目标与累计统计；完成标题使用摘要。

输出只有思考或空回复时，Actor 先缩小步骤自纠偏一次，再交 Logox 调整一次；主会话使用同样的有限规则。正文或工具截断最多自动接续两次，截断工具整批不执行。自动恢复在原任务显示“接续中／调整中”和简短原因，不增加模型额度或改变 high；真正新成果才能结束连续无交付，重派不刷新次数。耗尽后明确输入“继续”可授权一组新机会，并保留原任务、阶段和恢复记录；网络故障预算另计。

卡片点击在松开且未拖动时生效。收起的 Thinking/工具只点实际图标和标题；展开整块灰底可收起内层，露出的角色底色收起 Actor。可拖选角色名、标题、状态、按钮、框线及正文；复制屏幕文字，仅过滤左轨道。滚动、追加和缩放保持选区，边缘拖动自动滚动，纯软折行连接，真实换行保留。

Ctrl+C 有选区时只复制；无选区时首次短暂提示，1.5 秒内再次按下才退出，其它输入解除提示。Actor 页面 Esc 始终返回 Logox。主窗口先关闭补全、页面或答案编辑，普通对话中 Esc 只停止 Logox 当前循环。停止 Actor 使用卡片右侧 `■ 停止`，折叠时也能点击，或 Tab 聚焦后 Enter；其它任务不受影响。主循环停止后，Actor 回传只更新卡片和保存摘要，等下一次正式输入再交接。

命令结果、命令错误和请求错误以灰色系统轨道显示并保存；任务错误在原位置默认折叠。普通查询结果不自动进入模型上下文，模型、权限、工具和规范等有效环境变化会在相关角色下一次请求中告知。临时空白中的系统提示在首次正式任务前只留在界面。完整规则见[系统历史模块](modules/system-history.md)。

提供商、模型和思考档位在项目 `.logox/state/model-preferences.json` 保存；确认保存成功才生效，重启和换会话保留。不同项目分别保存。环境变量和 CLI 覆盖上次选择；取消或保存失败保持当前选择。任务运行或设置保存期间先等待或取消。

`read` 的 offset 从 1 开始；`edit` 使用精确的 old_text/new_text，匹配不唯一时不修改。UTF-8 BOM 和已有换行保留。`grep` 使用实际 rg，无 Shell 字符串拼接，达到全局结果上限后停止搜索。扫描忽略依赖、版本库、运行状态与敏感目录。

工具按 default、auto、creative 三档权限裁决，行为见下方“权限管理”。Shell 运行在工作目录中，Windows 使用 PowerShell；批准后按命令实际能力执行。它的任意文件改动不属于文件工具快照，`/undo` 只恢复受支持的 write/edit 修改。

许可默认拒绝。Tab 聚焦，方向键选择，Enter 确认；自由回答通过输入区编辑。Esc 先退出答案编辑或返回主窗口，Ctrl+X 取消当前交互；停止 Actor 使用卡片入口。拒绝、取消和参数错误都会作为工具结果返回模型，不会当成执行成功。

## 资源与扩展

角色人设由角色模块统一管理（内置档案或 `.logox/actors/<id>.md`，参见 `/actors`）。用户人工协作规范可放在 `~/.logox/AGENTS.md` 或 `CLAUDE.md`；项目规范逐层加载，每层按 `LOGOX.md`、`AGENTS.md`、`CLAUDE.md` 的顺序查当前目录及 `.logox`，由远到近进入请求上下文。每份最大 64 KiB，规范合计最大 128 KiB；坏文件和超限文件整份跳过并报告。`/status` 显示规范来源和未加载原因。

技能放在 `~/.logox/skills/<名称>/SKILL.md` 或当前项目 `.logox/skills/<名称>/SKILL.md`；frontmatter 的 name、description 提供名称与用途，正文由模型按需读取。技能目录本身不会增加工具。模板放在用户或当前项目 `.logox/commands/<名称>.md`；同名项目模板优先，内置名称不能覆盖。例如 review.md 正文为 `检查这些变更：{{args}}`，输入 `/review src` 会提交 `检查这些变更：src`。也支持 `$ARGUMENTS`、`$args`，参数最大 16 KiB，展开最大 64 KiB。/commands 与 slash 补全可查看模板。

/reload 必须在空闲时执行，保留历史与检查点，报告每类资源成功数与失败原因。它校验 config.toml，但提供商、MCP、hooks 和扩展代码仍需重启才应用配置变化。

MCP 配置在 config.toml 的 `[mcp.servers.<名称>]`，设置 command（可执行文件）、args（参数数组）、timeout（秒）和 startup_timeout_s。启动 LOGOX 时不连接，模型通过 mcp 的 list 查询目录，call 调用工具；调用参数先校验完整 schema，再按当前权限模式裁决。取消与超时回收该连接，下次可重新连接。当前支持 stdio。

观察 hooks 使用 `[hooks] enabled=true` 和 `[[hooks.entries]]`，entry 设置 event、command、args，可用 tool 过滤 post_tool_use。事件支持 session_start、post_tool_use、pre_compact、notification、stop，命令通过 stdin 接收 JSON。有 args 时 command 是可执行文件；省略 args 时 command 按 Shell 命令执行。也可将脚本放在当前项目或用户 `.logox/hooks/<事件名>.ps1` 等文件中，启动时发现；支持无扩展名、sh、py、ps1、cmd、bat、mjs、js，每层每个事件按此顺序选择一份。默认超时 5 秒，可设 timeout_s（最多 30 秒）；失败有诊断，任务继续。配置示例见 [config.example.toml](../config.example.toml)。

## 上下文与扬弃

默认保留最近两轮已结束对话和最近两条工具调用原文；当前工作轮独立。任务收尾保存一句话标题和简短报告，格式缺失时本地兜底，不增加总结请求。达到模型水位后复用这些摘要整理历史；较大工具原文归档后可按真实路径和行号回读。

/compact 在空闲时强制整理当前窗口角色；主窗口 Esc 停止整理，Actor 窗口 Esc 返回主窗口，可用该整理卡片停止；Ctrl+D 关闭并等待收尾。整理期间先等待或取消，再提交任务或切换模型。归档、汇总或落盘失败保留原文；仍超安全水位时不发送超预算请求。

模型窗口从当前能力目录或显式配置取得。未知模型会提示配置 context_window；自定义/本地模型填写真实窗口，例如：

```toml
[models."ollama/logox-qwen3.8:27b"]
context_window = 8192
max_output_tokens = 2048

[context]
keep_recent_rounds = 2
keep_recent_tools = 2
reserve_tokens = 32768
low_watermark_ratio = 0.5
```

provider.max_tokens 仍是独立输出上限，请求会按模型能力及剩余空间进一步裁剪。可用 max_budget_tokens/target_budget_tokens 压低高/低水位；target 必须小于 max。summary_provider/summary_model 可覆盖最终历史汇总，未配置时使用当前模型及已有登录认证。字段与完整示例见 [config.example.toml](../config.example.toml)。

/status 查看当前角色最近请求的输入占用、水位、输出额度和已记录用量。/usage 按请求模型分别列出任务、汇总、缓存及预估费用。统计保存在 `.logox/state/usage`，按会话/角色隔离；恢复不重复计入历史。重启保留摘要视图与累计统计，重新计算用量锚点。机制与失败恢复见[上下文模块](modules/context.md)。

中断后可以直接提交下一条消息。请求会跳过空助手消息并补齐中断工具批次的结果，原始思考和流程记录仍可阅读，不重放已执行工具。失败会显示 HTTP 状态和可识别的格式原因，新失败记录重启后仍能查看；未知格式错误不会盲目重试。

## 思考与费用配置

/effort 无参数打开选择器，带档位直接设置。auto 使用服务默认值，off 关闭思考；其余档位按模型支持列出。官方 DeepSeek 使用 low/high/max；已知 Anthropic 模型使用手动预算或 adaptive 协议。兼容服务通过 thinking_protocol 明确声明能力。最终历史汇总强制关闭思考，不改变用户档位。

```toml
[models."work/实际模型"]
context_window = 32768
thinking_protocol = "reasoning-effort"
thinking_levels = ["auto", "off", "low", "medium", "high"]

[models."work/实际模型".prices]
currency = "USD"
# 每百万 token 的静态价格；下面数字仅演示配置方式。
input = 2
output = 4
cache_read = 0.5
cache_write = 3
```

协议可选 deepseek、reasoning-effort（OpenAI兼容）、anthropic-budget、anthropic-adaptive（Anthropic原生）。手动预算需至少 1025 token 的输出额度，思考预算严格低于实际输出上限。输入已包含缓存，费用按非缓存输入、缓存读/写、输出分别计算；缺少用到的价格显示未知。价格修改后重启，按当前静态价格重新估算已记录用量。

## 保存、恢复与撤销

模型回复与每条工具结果在执行过程中保存到项目 `.logox/state/sessions`；目录不进入 Git。普通启动恢复当前项目最近的正式会话；没有历史时打开临时空白会话，首次正式任务才保存。`--session 标识` 可恢复指定会话，`--resume` 恢复最近打开的正式会话：

```powershell
npm start -- --session morning-check
npm start -- --resume
```

运行中用 `/new` 创建临时会话，`/resume` 选择本项目历史，或 `/resume ID` 直接恢复。取消保留当前窗口与草稿；切换成功后各窗口草稿、阅读位置和画布重置。模型选择、档位、项目规则与资源/MCP 连接保留，会话许可清理。任务、设置/权限保存、资源重载或整理期间先等待或取消。

在 `/resume` 中选中历史会话，按 Ctrl+X 打开删除确认，再选择“移到回收目录”。默认选中“取消”；删除后刷新列表，当前会话与草稿保留。当前会话需先 `/new` 再删除，被其他进程占用的会话不能删除。

删除副本保存在当前项目 `.logox/state/trash/<会话ID哈希-随机ID>/`。其中 `manifest.json` 记录会话 ID、项目、原相对路径和内容哈希，`files/` 保留原始记录、各分支、压缩与工具归档、用量及任务/协作状态。删除不会撤销项目文件修改。

需要手动恢复时：

1. 退出此项目的所有 LOGOX 进程，找到对应副本，核对 `manifest.json` 中的项目与会话 ID。
2. 按清单原相对路径，将 `files/` 下内容复制回项目 `.logox/state/`；先保留已有文件副本，尤其是删除时报告未清理的记录。
3. 内容放回后，移除 `.logox/state/deleted/<会话ID哈希>.json`。此哈希是回收目录名开头的 64 个字符；重新启动后可在 `/resume` 恢复。

同一会话只能由一个活进程持有；同机 PID 已死亡时自动恢复租约。锁损坏或来自另一台主机时显示诊断。恢复读取历史与任务检查点，中断任务标为中断；未配对工具调用在下一轮补失败结果，不自动续跑或重放工具。坏账本会提示将完整有效前缀恢复为新会话，源账本保留。目前支持本项目 TS 账本，Python 会话导入待后续迁移。

`/clear` 只清显示；模型仍保留已有上下文。`/rewind` 撤销所选轮次及之后的全会话对话与 write/edit 修改；原始账本保留，有效分支与压缩状态同时更新。全部文件恢复成功才推进历史；部分失败列出已恢复/失败路径，修复后重试相同目标，期间禁止新模型任务。Shell/MCP 外部副作用不由文件回退恢复。实际已经消费的模型用量保留，切回历史不再次计费。

write/edit 在修改前保存原字节；备份失败或文件等待期间发生变化时不执行修改。`/undo` 只筛选当前会话，按最近活动倒序核对结果，再恢复文件；新建文件会删除。如果用户在这之后手工修改了文件，撤销停止并保留用户内容。任务仍运行时先取消或等待完成，再撤销。

## 权限管理

`/permissions` 查看模式、规则、近期裁决理由和审批用量；`/permissions mode` 打开模式选择器，也可直接输入 `/permissions mode default|auto|creative` 保存项目模式。

| 模式 | 行为 | 提示色 |
|---|---|---|
| default | 普通读取允许，修改、命令和未知副作用默认人工审批；已有允许规则可免审 | 灰色 |
| auto | 项目常规编辑与安全读取直接允许，不确定操作交会话模型审查，危险操作人工确认 | 蓝色 |
| creative | 不调用审批模型，规则确定危险就阻止，其余默认允许 | 紫色 |

三档统一覆盖文件、Shell、MCP 和全部角色，显式 deny 始终优先。审批模型错误自动重试一次，仍失败就暂停当前操作；在所属卡片重试或切换模式后重新裁决。用户拒绝后寻找其他方案，相同授权不反复请求；单次批准不学习长期规则。审批实际 token 计入 `/usage`，缺失用量显示未返回。

诊断问题时可以读取 `.logox/state/sessions`、`usage` 等普通运行记录；指定这些目录或文件的 grep/glob 也会返回实际结果。项目根目录的普通搜索默认跳过运行目录，要查运行记录时指定路径或 glob 模式。creative 不会仅因路径包含 `.logox` / `.logox-ts` 拒绝读取；真实 auth.json、私钥、.env 等凭据，以及改写、删除运行记录仍受保护。

`/permissions add session allow write src/**` 允许本会话普通源码写入；将 session 改为 project 可持久保存。`/permissions add project deny read .env*` 新增拒绝规则，`/permissions revoke ID` 按页面 ID 撤销。Shell 模式使用静态词元前缀，如 `git status`；路径支持 *、**、?；mcp 工具规则覆盖整个 MCP 命名空间。模式等待中可切换，新增或撤销规则仍需空闲。项目模式在重启后保留，会话规则在成功切换会话后清空。

配置 `[permissions]` 的 `readonly_concurrency` 为 1–8，默认 4；只有连续 read/glob/grep 可并发，结果按模型顺序保存。
