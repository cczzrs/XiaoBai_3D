# 项目结构与维护

所有路径均相对项目根目录；`web/` 与 `temp/` 不是系统根目录下的文件夹。

## 目录职责

| 目录 | 内容 | 维护方式 |
| --- | --- | --- |
| `web/` | HTML、CSS、前端模块和本地浏览器依赖 | 页面代码统一在此；默认配置为 `web/src/config.js` |
| `assets/approved/` | 批准的头部和身体原件 | 保持原字节 |
| `assets/design/` | 已保存的部件、绑定、动作版本 | 已批准版本同样受保护；新版本另建目录 |
| `assets/imports/` | 用户导入的源模型 | 保留来源文件，不当作临时导出 |
| `assets/references/` | 参考图及配准数据 | 与模型资产分开管理 |
| `docs/approvals/` | 历史批准记录及哈希 | 不回写旧记录，后续批准另建文件 |
| `docs/qa/` | 已保留的报告、截图 | 作为历史证据，测试不得覆盖 |
| `tests/fixtures/` | 固定测试输入，包括坏文件样例 | 不由测试运行覆盖 |
| `scripts/` | 启动、生成、核验等开发工具 | 与网页运行代码分开 |
| `temp/` | 临时导出、日志、生成实验、排查快照 | 产物可再生成；默认不加入版本控制 |

根目录 README 提供启动方式和文档索引。使用细节集中在 [WORKBENCH.md](WORKBENCH.md)，资产依据在 [ASSETS.md](ASSETS.md)，历史检查在 [VALIDATION.md](VALIDATION.md)。

## 页面地址与磁盘路径

`./dev.sh` 使用 `scripts/serve.py`，仅监听 `127.0.0.1`。页面根目录为 `web/`，访问 `/` 或 `/web/` 均可；两种入口都将 `assets/` 和 `docs/` 请求映射到项目根目录的对应文件夹。

| 浏览器地址 | 磁盘文件 |
| --- | --- |
| `/` 或 `/web/` | `web/index.html` |
| `/src/config.js` 或 `/web/src/config.js` | `web/src/config.js` |
| `/styles/studio.css` | `web/styles/studio.css` |
| `/vendor/three.module.js` | `web/vendor/three.module.js` |
| `/assets/manifest.json` | `assets/manifest.json` |
| `/docs/approvals/actions-v1-approved.json` | 同名批准记录 |

`temp/`、`tests/` 和 `scripts/` 不作为网页资源提供。必须使用项目服务器；普通的根目录静态服务不具备这些映射。项目 JSON 版本、资源标识和 localStorage 键保持不变。

## 历史路径与哈希

批准记录中的 `src/limb-rig.js`、`src/action-motion.js`、`src/face-rig.js`、`qa/…` 是记录建立时的路径。目录整理没有改写这些记录或其哈希。

[project-layout.json](project-layout.json) 保存旧路径到当前路径的映射。校验工具使用 `scripts/project-paths.mjs` 的 `historicalURL()` 查找新位置，再按原 SHA-256 比较文件内容。映射只改变查找位置，不替换批准依据。当前资产文件路径保持稳定；导入源 OBJ 归入 `assets/imports/`。

## 临时输出

- `temp/qa/`：新运行的测试报告、控制台日志、试导出的 GLB。
- `temp/generated/legs-v1/` 与 `temp/generated/legs-v2/`：历史生成器的新运行结果。
- `temp/layout-migration/`：本次整理前的哈希清单和文档快照。
- `temp/system/`：迁入的 Finder 元数据。

`build-legs.mjs` 和 `build-legs-v2.mjs` 现在只写临时目录，读取版本资产作为输入。`check-actions-export.mjs` 只读模型，报告写入 `temp/qa/`，不会把导出复制回批准目录。测试通过 `temporaryOutput()` 自动创建所需目录，清理临时产物后仍可运行。

需要正式保留的验证结果应以新名称放入 `docs/qa/` 并说明范围。需要正式保留的新模型应在 `assets/design/` 建新版本并等待审批，不能直接覆盖批准文件。

## 验证与版本控制

`npm run test:layout` 检查结构迁移、资源服务、依赖及批准文件。其它专项测试按改动范围选择；不默认执行全流程回归。

本次整理只移动工作区文件，不执行 Git 提交，也不调整已有暂存内容。`temp/` 的产物被忽略；整理前已经暂存的旧路径仍由用户在后续版本控制阶段处理。
