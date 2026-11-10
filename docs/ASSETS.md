# 小白 3D 资产与审批依据

本项目导入已有审批模型，不重新生成头部或身体。源项目保持只读。模型和参考图均按原始文件字节复制；`assets/manifest.json` 记录完整来源、SHA-256、审批与坐标数据。

## 已批准模型

| 部件 | 文件 | 审批 | 网格节点 | 顶点 / 三角形 |
| --- | --- | --- | --- | --- |
| 头部 | `assets/approved/head-v1/xiaobai-head.glb` | head-v1，2026-09-16 00:04:51 UTC | Head、Eye_L、Eye_R、Nose | 92,836 / 185,664 |
| 身体 | `assets/approved/body-v7/xiaobai-torso.glb` | body-v7，2026-09-16 03:10:11 UTC | Body | 36,674 / 73,344 |
| 双臂 | `assets/design/arms-v59/left-arm.glb`，右侧 X 镜像 | v59 组合，2026-11-09 | 左右各一个 Arm_L 实例 | 138,532 / 277,056（双臂） |
| 腿脚 | `assets/design/legs-v2/legs.glb` | legs-v2，2026-11-09 | Leg_L、Leg_R | 52,484 / 104,960 |

- 头部 SHA-256：`2fc19d89fc33f57f46ac7fe716f3ae04e1b8a243b502c0cdf625f60ac4648351`
- 身体 SHA-256：`9a7b08fa9a629f857d26d2fc8c094b95f53e8fbe2c8cf56a4c0ac7e2c529a5b4`
- v59 左臂资源 SHA-256：`c6d26f71133dfddabfd9128e068e229be6b65c001e9a66ff914532b32e5067ee`
- 腿脚 v2 SHA-256：`3269336fc38594119e69769fd7ae86d6414442191edca6b66d149858e04261f4`

头部、身体均与各自原始 `APPROVAL.json` 中的记录相符，并核对了复制前后的文件。审批 JSON 原样保存于对应部件目录。原批准文件包含更多历史文件的哈希，因此不是本项目必须复制全部文件的清单。双臂及腿脚的后续批准记录保存在 `docs/approvals/`。

头部审批原话为「批准！已批准的内容只有再次批准修改时才能修改！」；身体审批原话为「批准！参考这个图像内容画手臂，以图中最后一个动作的图像为主！左右手对称！」。后一句批准的是身体并进入手臂阶段，不能据此把后续手臂或腿脚候选列为已批准。

后续用户明确批准了头部、身体与 v59 镜像双臂的组合，精确原文及文件哈希记录于 `docs/approvals/v59-assembly-approved.json`。手臂的独立资源仍在 `assets/design/arms-v59/`，保持原字节、原比例及镜像位置；该次批准的范围不包含腿脚，腿脚另有下述明确批准。

腿脚 `assets/design/legs-v1/legs.glb` 是待确认设计副本。采用历史 `xiaobai-body-review/analysis/leg-fit.json` 中的连续正面轮廓数据，参考标准多视图补充前后深度；历史拟合本身从未作为批准腿部网格。原始拟合副本、生成参数、来源与输出哈希随资产保存。单腿曲面连续覆盖 Y=0…30，不在脚踝测量边界切分；两腿关于 X=0 镜像。尺寸和闭合网格校验不能替代外形确认。

当前默认腿脚为 `assets/design/legs-v2/legs.glb`（`legs-smooth-v2-mirrored`）。用户于 2026-11-09 明确批准其外形及与已批准组合的衔接，原话、范围和锁定文件哈希见 `docs/approvals/legs-v2-approved.json`。该次批准先授权绑定设计，随后 rig-v1 与 actions-v1 也已分别批准。`docs/legs-v2-review.md` 保留历史评审说明并链接当前批准记录。

原 v1 的 `legs-reference-v1-mirrored` 标识及文件继续保留，未因 v2 批准而成为已批准资产；旧项目按原标识加载。只有点击「使用腿脚 v2 设计副本」才替换当前腿脚候选。revision 1–6 项目迁移至 revision 7 时保留原参数和资源标识，仅补充中立绑定数据。

部分 GLB 导出时间早于审批，文件内部仍有 `pending`、`candidate`、`Torso_Cream_Candidate` 等历史名称。这些字段没有改写，最终审批以原 `APPROVAL.json` 及 `docs/approvals/` 中相应的后续批准记录为依据。`head-fit.json` 等历史分析数据中也可能保留待审批文字。

形体、骨骼和动作参数作用于独立设计副本；导出文件属于设计稿，不能覆盖批准源资产。改变已批准头部、身体、v59 手臂及腿脚 v2 的几何、法线、拓扑、材质、比例或装配位置，须用户再次明确批准。

## 绑定设计副本 rig-v1

`assets/design/rig-v1/xiaobai-rig-v1.glb` 是已批准的中立绑定模型；同目录 `project.json` 恢复可编辑参数，`provenance.json` 记录来源与状态。完整模型含 9 个网格、320,526 顶点、641,024 三角形，四肢为 4 个蒙皮网格，每顶点最多 4 个权重；20 个 Bone 节点包括 4 个基础节点和 16 个四肢节点，其中 4 个末端定位点没有独立表面权重。头身沿用刚性层级，手臂根部与腿根接触环分别锚定 Body 和 Root。

绑定只加入设计副本，不改写批准源文件或中立几何属性。GLB 保留 skins、关节、权重及逆绑定矩阵，动画片段为 0。静态部件导入入口仍不接受蒙皮 GLB；通过「打开项目」加载 `project.json` 恢复绑定草稿。详细范围、关节坐标及验收项见 [rig-v1-review.md](rig-v1-review.md)。

## 动作设计副本 actions-v1

用户已批准 rig-v1，并在动作交付后明确表示“全部批准！更新所有相关文档和代码。”。当前动作批准记录为 `docs/approvals/actions-v1-approved.json`，继承前序批准并锁定 24 个基线文件。骨骼静止位置、蒙皮权重、几何、材质及动作计算均未因登记批准而改变。

`assets/design/actions-v1/xiaobai-actions-v1.glb` 包含五个已批准片段：步行 1.2 秒、小跑 0.8 秒、招手 2 秒、思考鼻伸缩 4 秒，及坐姿保持样片。可调参数随同目录的 revision 8 `project.json` 保存，默认值来自此前批准的 `xiaobai-rigged-3d/motion-config.js`。鼻子只在设计动作中伸缩，中立属性仍与原件一致。详情见 [actions-v1-review.md](actions-v1-review.md)。动作 GLB、项目、默认参数及原 provenance 保留交付字节，历史 pending 字段由新批准记录取代。后续参数修改不会自动成为新的批准基线；新导出以 `modified-design-copy` 标记修改后的动作参数。

## 坐标与预览

头部和身体源 GLB 使用同一原始 H100 参考单位，+Y 向上，+Z 为面部朝向。坐标单位不是米。节点没有额外的平移、旋转、缩放；直接装入同一场景即可，不要自动归一化或逐件居中。这两个批准源 GLB 内没有骨骼或动画；rig-v1 的骨骼仅存在于设计副本。

| 节点 | 最小坐标 [x, y, z] | 最大坐标 [x, y, z] |
| --- | --- | --- |
| Head | [-40.8000, 41.8000, -35.0000] | [40.8000, 98.4000, 35.0000] |
| Eye_L | [-27.7500, 54.5500, 26.3230] | [-11.6500, 77.0500, 34.3725] |
| Eye_R | [11.6500, 54.5500, 26.3230] | [27.7500, 77.0500, 34.3725] |
| Nose | [-6.9500, 62.2000, 34.4631] | [6.9500, 66.8000, 37.4812] |
| Body | [-19.8781, 16.4499, -17.9973] | [19.8781, 56.0000, 17.9973] |

上述边界已经从 GLB 二进制 POSITION 顶点重新计算并与 accessor 边界核对。身体上部延伸至头部内部是原批准结构；不要裁去重叠部分。

推荐正交相机：整体 target `[0,50,0]`、纵向 span `126`；头部 target `[0,70.1,0]`、span `78`；身体 target `[0,32.5,0]`、span `64`。距离 `260`。正面相机从 +Z 观察，右侧名义 yaw 为 `-90°`。原批准预览采用黑背景、ACES tone mapping、exposure `2.05`、白色均匀环境光强度 `2.8`，默认关闭定向光。相机和灯光是预览设置，不需要写入源模型。

## 参考图与配准

`assets/references` 保存四张原像素 PNG：

- `01-turnaround.png`：1536 × 1024，头部八向参考。
- `01-standard-views.png`：1536 × 1024，标准 T 姿与放松姿。
- `spritesheet-extended.png`：1536 × 415，身体批准流程使用的 16 帧参考；每格宽 192，行距 208。
- `03-playful-actions.png`：1536 × 1024，手臂最后动作参考；从用户原文件复制，其哈希与历史手臂配准记录一致。

前三张文件来自源项目 `xiaobai-body-review/reference`，并核对与 `xiaobai-head-review/reference` 的同名文件完全一致。图片中的手臂和腿脚是视觉参考，不代表已批准的 3D 网格。

`registration.json` 是由原审批快照的 `head-review-config.js` 与 `body-view-registration.json` 提取的配准索引。原始 `head-fit.json` 与 `body-view-registration.json` 也一起保留。索引中的 crop 与 center 都使用完整原图像素坐标。映射规则为：

```text
xWorld = (imageX - centerX) × scale
yWorld = (floorY - imageY) × scale
```

| 用途 | 图像 / crop [x,y,w,h] | centerX | floorY | scale（世界单位/像素） |
| --- | --- | ---: | ---: | ---: |
| 头部正面 | turnaround / [0,60,384,237] | 195.5 | 457.525686 | 81.6 / 316 |
| 身体主参考 | sprites / [0,0,192,207] | 94.5 | 201.5 | 81.6 / 148 |
| 身体正面八视图 | turnaround / [0,0,384,512] | 195.5 | 470.263247 | 81.6 / 316 |
| 身体标准 T 姿 | standard / [0,0,512,512] | 261.5 | 498.663652 | 81.6 / 354 |

手臂参考的第 6 个（最后一个）动作位于 crop `[1024,512,512,512]`；历史候选映射 `centerX=1278.5`、`floorY=975.2156862745098`、`scale=0.23720930232558138`。配准来自 `xiaobai-arms-review/analysis/arms-fit.json`，它表示候选阶段的参考对照，不构成手臂审批或精确相机标定。

头部与身体历史流程使用的同一八视图存在不同的垂直配准，不能混用或声称整张图都精确匹配。按当前核对部件选择配准；整体显示应标明为参考对照。八视图角度是原流程的名义角度，原图片相机未标定，叠图不能证明三维表面完全正确。

## Three.js 依赖

使用原身体审批包中的 Three.js `0.186.0`：`three.module.js`、`three.core.js`、GLTFLoader、GLTFExporter、OrbitControls、BufferGeometryUtils、SkeletonUtils。完整 MIT 许可证保存在 `web/vendor/LICENSE`，原包元数据保存在 `web/vendor/package/package.json`。这些文件保留原字节。

原包没有 OBJLoader，因此从 [Three.js 官方 r186 源码](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/loaders/OBJLoader.js) 补齐相同版本，保存为 `web/vendor/addons/loaders/OBJLoader.js`。它仅依赖 `three`；GLTFLoader 的两个本地 utils 依赖已一起保存。页面启动无需从 CDN 取依赖。

## 验证范围

初次迁移完成了两个源 GLB、两份审批文件、复制资产的哈希校验，重新读取全部模型顶点验证坐标边界，确认两个源 GLB 不带骨骼或动画，并检查所复制模块的直接依赖。对应历史检查为 `node --test tests/assets.test.mjs`。

历史绑定相关 52 项测试通过，涵盖 revision 7 项目迁移、绑定、GLB 往返和旧腿脚 v1 审批状态；未执行全流程回归。实际 Chrome 下载文件的独立核验见 `docs/qa/rig-v1-export-check.json`：13 个锁定文件哈希不变，原 POSITION、NORMAL、索引和材质一致，4 skins / 20 bones / 0 clips。GLB 逆绑定矩阵的 Float32 解码精度使中立 CPU 蒙皮位置最大偏差约为 0.000001142 H100，原始顶点数据没有改变。这些检查验证资产保存和绑定实现，绑定现已获用户确认，后续批准记录为 `docs/approvals/rig-v1-approved.json`。

动作交付时的历史专项检查为 56 项通过，最终导出另作回读与逐顶点抽样接地检查。实际浏览器导出证据为 `docs/qa/actions-v1-browser-export-check.json`，页面交互证据为 `docs/qa/actions-v1-browser-checks.json`。未执行全流程回归。

本次批准同步的 10 项专项检查通过，24 个基线文件保持原字节；Chrome 默认导出与批准动作文件的二进制数据块一致。专项记录见 `temp/qa/actions-v1-approval-tests.txt` 与 `docs/qa/actions-v1-approval-browser-checks.json`；仅验证当前改动，历史报告按当时状态保留。
