# 专项验证记录

本文中代码格式的路径均相对项目根目录。

## 目录整理（2026-11-09）

网页代码整体迁入 `web/`，正式 QA 证据迁入 `docs/qa/`，可复用样例迁入 `tests/fixtures/`，临时日志与导出迁入 `temp/`。历史批准记录通过 `docs/project-layout.json` 解析旧路径，内容和哈希保持不变。

- 目录、HTTP 资源映射、文档链接、依赖及批准基线专项 8 项通过；动作 GLB 导出专项 1 项通过。
- 两个腿部生成脚本均实际运行，输出只在 `temp/generated/`。
- 外部 Chrome 检查 `/` 与 `/web/`，4 个已批准部件正常显示，播放、暂停、时间轴及实际导出正常。
- 迁移后 135 个非临时文件与整理前字节一致，包含 18 个网页源码模块；24 个批准基线文件和 4 份后续批准记录保持不变。
- 浏览器动作导出与整理前的批准状态导出 SHA-256 完全一致；未执行全流程回归、Git 提交或暂存调整。

完整记录见 [project-layout-checks.json](qa/project-layout-checks.json)，临时日志保存在 `temp/qa/`。

## 动作 v1 批准同步（2026-11-09）

用户于 2026-11-09 明确表示“全部批准！更新所有相关文档和代码。”。界面、默认配置、资产清单与导出审批标记已同步；原件和动作计算保持不变。小跑屈膝时腿脚内侧的局部收尖作为已展示效果一并接受，本轮没有修改蒙皮。

专项检查命令：

```sh
node --test tests/action-approval.test.mjs tests/action-motion.test.mjs
```

10 项相关检查通过，覆盖批准记录、参数状态、动作导出和基线哈希；外部 Chrome 已检查状态显示、参数修改/恢复及两种审批状态的实际导出。24 个基线文件保持原字节，新默认动作导出的二进制数据块与已批准动作文件完全一致，见 `docs/qa/actions-v1-approval-motion-equality.json`。记录见 `temp/qa/actions-v1-approval-tests.txt`、`docs/qa/actions-v1-approval-browser-checks.json`。`scripts/check-actions-export.mjs` 只读取输入模型并向 `temp/qa/` 写入新报告，不再将文件复制到批准资源目录。未进行全流程回归或 Git 提交。

## 历史动作验证

```sh
node --test tests/project-state.test.mjs tests/action-motion.test.mjs tests/face-rig.test.mjs tests/model-io.test.mjs
```

56 项相关检查通过，另在最终导出采样密度变更后复核动作 GLB 回读。Chrome 逐项调整 27 个参数、左右招手、保存恢复、默认值恢复及播放暂停；实际下载文件由 `scripts/check-actions-export.mjs` 独立核对。19 个锁定文件与全部原始几何/权重/材质不变。未执行全流程回归。

## 历史绑定验证

```sh
node --test tests/project-state.test.mjs tests/rig-binding.test.mjs tests/model-io.test.mjs tests/legs-v1.test.mjs
```

52 项相关测试通过：项目格式与迁移 35 项、绑定 7 项、模型导入导出 5 项、历史腿脚 v1 与审批状态 5 项。覆盖 13 个锁定文件哈希、中立形体与原属性、权重归一化和左右隔离、关节重绑定、静态旋转及 GLB 往返。当时未执行全流程回归。

历史 Chrome 导出核验见 `docs/qa/rig-v1-export-check.json`：9 个网格、320,526 顶点、641,024 三角形、4 个 skins、20 个骨骼节点、0 个动画片段。原 POSITION、NORMAL、索引及材质全部一致，13 个锁定文件保持原字节；重新解码 GLB 后 CPU 蒙皮求值的最大中立位置误差约为 0.000001142 H100，来自逆绑定矩阵的 Float32 精度。绑定的后续批准以 `docs/approvals/rig-v1-approved.json` 为准。

若系统未安装 Node，可将命令中的 `node` 替换为 `/Users/cong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。

## 历史专项验证

初始项目检查覆盖审批哈希、依赖、项目验证、错误文件、候选保存与恢复，Chrome 记录见 `docs/qa/browser-checks.json`。以下是各功能当时的专项记录，本轮未重复执行。

眼鼻功能的相关测试单独运行：

```sh
node --test tests/face-rig.test.mjs tests/project-state.test.mjs
```

五官 Chrome 检查记录见 `docs/qa/face-browser-checks.json`；本次没有执行全流程回归。GLB 导出包含当前眼鼻形变和静态表情，预设动画参数随项目 JSON 保存，不导出动画关键帧。

外观功能的专项测试：

```sh
node --test tests/appearance.test.mjs tests/image-io.test.mjs tests/project-state.test.mjs
```

表情和内部开合专项检查：`node --test tests/face-rig.test.mjs tests/project-state.test.mjs tests/appearance.test.mjs`；Chrome 记录见 `docs/qa/expression-browser-checks.json`。

外观 Chrome 记录见 `docs/qa/appearance-browser-checks.json`，覆盖颜色、真实图片解码、背景比例、保存恢复、贴图 GLB 与五官动作兼容。本轮只执行相关功能检查。

模型与参考来源详情见 [docs/ASSETS.md](ASSETS.md)。没有执行 Git 提交或部署。

v59 双臂接入的相关检查：

```sh
node --test tests/arm-v59.test.mjs tests/model-io.test.mjs tests/project-state.test.mjs
```

覆盖源数据不变、左右逐顶点镜像、四类走线、设计双臂的 GLB 导出及项目恢复；Chrome 记录见 `docs/qa/v59-browser-checks.json`。

腿脚首版的历史检查为 38 项通过，覆盖流形/法线、镜像、脚部尺寸、GLB 往返、批准资产哈希与 revision 6 草稿恢复；多视角记录见 `docs/qa/legs-v1-browser-checks.json`。

v2 实际 Chrome 导出的历史独立核验见 `docs/qa/legs-v2-export-check.json`：9 个网格、641,024 个三角形。7 个当时已批准网格的世界坐标、世界法线、索引和材质均与原件一致（右臂按 X 镜像）；两腿与 v2 资源一致，显示线未进入导出。与保存的 v1 直接比较，连接起始环及以下每腿 14,561 个原顶点坐标保持不变。后续腿脚外形的明确批准另记于 `docs/approvals/legs-v2-approved.json`，历史评审文档保留原内容。

`scripts/build-legs-v2.mjs` 与 `scripts/build-legs.mjs` 保留为历史生成脚本。v2 已获批准，新的运行结果统一写入 `temp/generated/`，不能重建覆盖已批准资源。
