# 小白 3D · 角色工作台

本地运行的模型装配、形体、骨骼和动作工作台。当前已批准：头部 head-v1、身体 body-v7、v59 镜像双臂、腿脚 v2、关节绑定 rig-v1 和动作 actions-v1。批准资产保留原件，后续编辑使用独立设计副本。

当前设计使用 **v8 前后对称独立双腿**：以原脚中面为固定对称面，修正 v7 腿身及顶部向后偏移的问题。左腿和右腿各自独立，顶部为圆润椭圆弧面，脚部保留原数据；身体接合处使用新的配套设计副本。详见 [v8 对称修正记录](docs/legs-v8-review.md)。

形体设计页可加载 v8，并保留 v7、v6、v5、v4、v3 和 v2 对照入口。新外形、配套身体及绑定效果待确认；批准原件及历史审批记录保留。新建项目默认仍沿用 v2，显式选择和保存的版本会随项目恢复。

[双腿 GLB](assets/design/legs-v8/legs.glb) · [左腿 GLB](assets/design/legs-v8/leg-left.glb) · [右腿 GLB](assets/design/legs-v8/leg-right.glb) · [配套身体副本](assets/design/legs-v8/body.glb)。完整绑定与五个既有动作保存在 [rig-v8 设计目录](assets/design/rig-v8/)。原绑定、动作定义和批准资产保留原字节，过程证据保存在 `temp/`。

## 启动

在项目根目录运行：

```sh
./dev.sh
```

使用外部 Chrome 打开 [工作台](http://127.0.0.1:8790/)。端口占用时可运行 `./dev.sh --port 8791`。`/` 与 `/web/` 均可访问页面；请使用项目的启动脚本，不直接双击 HTML。

网页入口位于 `web/index.html`。服务器将 `web/` 作为页面根目录，并将 `/assets/`、`/docs/` 映射到项目同名目录；因此已保存项目的资产地址和浏览器存档无需迁移。依赖已随项目保存，无需 npm 安装或 CDN。

## 项目结构

```text
web/                    页面入口、前端源码、样式、本地 Three.js 依赖
  index.html            固定 HTML 结构
  src/                  3D、交互、状态；config.js 集中管理默认配置
  styles/               页面样式
  vendor/               本地浏览器依赖与许可证
assets/                 模型原件、设计版本、参考图、导入源文件
  approved/             原始批准头部与身体
  design/               双臂、腿脚、绑定和动作的版本资产
  imports/              用户导入的源模型
  references/           参考图片与配准数据
docs/                   使用说明、结构约定、资产说明、审批与评审
  approvals/            不改写的批准记录
  qa/                   保留的正式验证报告和截图
tests/                  功能测试
  fixtures/             可复用测试样例
scripts/                启动、生成、校验、路径解析工具
temp/                   临时导出、运行日志、生成实验、迁移快照
dev.sh                  启动入口
package.json            项目命令
AGENTS.md               项目工作约定
```

`assets/design/` 是版本资产目录，不能仅凭目录名判断是否批准；以资产清单及审批记录为准。`temp/` 中的产物已加入忽略规则，不存放唯一的批准资产。

## 文档入口

- [工作台使用说明](docs/WORKBENCH.md)：装配、形体、绑定、动作、材质、保存与导出。
- [项目结构与维护](docs/PROJECT_STRUCTURE.md)：目录职责、服务器路径、临时产物和历史路径映射。
- [资产与审批依据](docs/ASSETS.md)：来源、坐标、哈希和批准范围。
- [身体与腿 v6 评审](docs/legs-v6-review.md)：身体接缝与脚腕的圆润过渡、脚部保留及本轮相关验证。
- [腿部 v6 绑定与动作接入](docs/legs-v6-rig-review.md)：连续蒙皮、关节姿态、动作预览和导出，以及形体批准与绑定待确认的边界。
- [身体与腿 v5 评审](docs/legs-v5-review.md)：上一版融合副本、脚部保留与模式切换。
- [动作 v1 说明](docs/actions-v1-review.md) · [绑定 v1 说明](docs/rig-v1-review.md) · [腿脚 v2 说明](docs/legs-v2-review.md)。
- [当前动作批准记录](docs/approvals/actions-v1-approved.json)：继承前序批准与 24 个基线文件快照。
- [专项验证记录](docs/VALIDATION.md)：各阶段检查及其范围。

## 本次目录调整验证

```sh
npm run test:layout
```

本次目录与批准专项 8 项、动作导出专项 1 项均通过，两个生成器和外部 Chrome 检查通过，批准资产保持不变。该命令只检查目录、HTTP 资源映射、依赖和批准基线；全流程测试仍需按 `AGENTS.md` 先获批准。迁移详情见 [目录验证记录](docs/qa/project-layout-checks.json)。临时日志写入 `temp/qa/`。

HTML 管理结构，CSS 管理样式，JavaScript 管理交互和 3D 渲染。页面默认配置集中在 `web/src/config.js` 的冻结 `APP_CONFIG` 中。
