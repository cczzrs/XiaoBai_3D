# 项目工作约定

- Git 进行任何提交操作都要请求批准并给出理由和提交说明建议。
- 测试仅做本次改动相关的功能测试；如有必要进行全流程回归测试，要请求批准。
- 使用外部浏览器 Chrome 检查前端页面和功能测试。
- 不使用 JavaScript 构建 HTML 和渲染 CSS。HTML 管理固定结构，CSS 管理样式。
- 页面默认配置及默认值统一在 web/src/config.js 的 APP_CONFIG 冻结树形对象中，各司其职，便于阅读和修改。
- assets/approved 中的头部和身体是批准基线。任何新形体、骨骼、姿态变换都应用在设计副本；未经用户再次明确批准，不覆盖批准原件。

## 目录约定

- web/ 放页面入口、前端源码、样式及本地浏览器依赖；assets/ 保留模型和参考资产。
- docs/ 放说明和审批记录，docs/qa/ 保留正式验证证据；tests/fixtures/ 放可复用测试样例。
- 临时导出、运行日志、生成实验和排查快照统一写入 temp/，不写回 assets/ 或覆盖 docs/qa/ 的历史记录。
- 历史审批记录保持原字节。旧路径通过 docs/project-layout.json 与 scripts/project-paths.mjs 解析后再核对原哈希。
