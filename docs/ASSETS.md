# 小白 3D 资产与审批依据

本项目导入已有审批模型，不重新生成头部或身体。源项目保持只读。模型和参考图均按原始文件字节复制；`assets/manifest.json` 记录完整来源、SHA-256、审批与坐标数据。

## 已批准模型

| 部件 | 文件 | 审批 | 网格节点 | 顶点 / 三角形 |
| --- | --- | --- | --- | --- |
| 头部 | `assets/approved/head-v1/xiaobai-head.glb` | head-v1，2026-09-16 00:04:51 UTC | Head、Eye_L、Eye_R、Nose | 92,836 / 185,664 |
| 身体 | `assets/approved/body-v7/xiaobai-torso.glb` | body-v7，2026-09-16 03:10:11 UTC | Body | 36,674 / 73,344 |

- 头部 SHA-256：`2fc19d89fc33f57f46ac7fe716f3ae04e1b8a243b502c0cdf625f60ac4648351`
- 身体 SHA-256：`9a7b08fa9a629f857d26d2fc8c094b95f53e8fbe2c8cf56a4c0ac7e2c529a5b4`

两者均与各自原始 `APPROVAL.json` 中的记录相符，并核对了复制前后的文件。审批 JSON 原样保存于对应部件目录。原批准文件包含更多历史文件的哈希，因此不是本项目必须复制全部文件的清单。

头部审批原话为「批准！已批准的内容只有再次批准修改时才能修改！」；身体审批原话为「批准！参考这个图像内容画手臂，以图中最后一个动作的图像为主！左右手对称！」。后一句批准的是身体并进入手臂阶段，不能据此把后续手臂或腿脚候选列为已批准。当前项目没有导入任何已批准手臂或腿脚。

GLB 导出时间早于审批，文件内部仍有 `pending`、`candidate`、`Torso_Cream_Candidate` 等历史名称。这些字段没有改写，最终审批以旁置 `APPROVAL.json` 为依据。`head-fit.json` 等历史分析数据中也可能保留待审批文字。

形体、骨骼和动作参数应作用于独立设计副本；导出文件属于设计稿，不能覆盖批准源资产。改变原批准头部、身体的几何、材质、比例或位置，仍须用户再次明确批准。

## 坐标与预览

两个 GLB 使用同一原始 H100 参考单位，+Y 向上，+Z 为面部朝向。坐标单位不是米。节点没有额外的平移、旋转、缩放；直接装入同一场景即可，不要自动归一化或逐件居中。GLB 内没有骨骼或动画。

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

使用原身体审批包中的 Three.js `0.186.0`：`three.module.js`、`three.core.js`、GLTFLoader、GLTFExporter、OrbitControls、BufferGeometryUtils、SkeletonUtils。完整 MIT 许可证保存在 `vendor/LICENSE`，原包元数据保存在 `vendor/package/package.json`。这些文件保留原字节。

原包没有 OBJLoader，因此从 [Three.js 官方 r186 源码](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/loaders/OBJLoader.js) 补齐相同版本，保存为 `vendor/addons/loaders/OBJLoader.js`。它仅依赖 `three`；GLTFLoader 的两个本地 utils 依赖已一起保存。页面启动无需从 CDN 取依赖。

## 本次验证边界

完成了两个源 GLB、两份审批文件、复制资产的哈希校验，重新读取全部模型顶点验证坐标边界，确认两个 GLB 不带骨骼或动画，并检查所复制模块的直接依赖。此验证证明资产迁移没有改变批准文件，不等同于新的外形审批、动作验收或全流程回归测试。

仅本资产迁移相关的自动检查：`node --test tests/assets.test.mjs`，核验两份批准 GLB 的固定哈希与审批记录，以及本地 vendor 依赖是否齐全。
