# GeoPics

上传带 EXIF 的原图，自动读取拍摄经纬度与日期，结合 Mapbox 静态地图，在 Canvas 2D 上合成"地图 + 照片 + 城市大字 + 坐标日期"的创意海报。

## 目录结构

```
.
├── app.js / app.json / app.wxss / sitemap.json   # 小程序入口与全局配置
├── project.config.json                            # 开发者工具配置（appid 请替换）
├── utils/
│   ├── config.js          # Mapbox token / 样式 ID 等配置
│   ├── exif-parser.js     # ArrayBuffer EXIF 解析：GPS(DMS→十进制)、拍摄日期、方向
│   ├── map-service.js     # 逆地理编码、全球地点搜索、静态图 URL、下载、GCJ-02→WGS-84
│   ├── themes.js          # 地图配色预设与自定义颜色解析
│   ├── place-name.js      # 地名规范化：英文 / 中文，汉字短名转拼音、长名转首字母缩写
│   └── pinyin-data.js     # 汉字→拼音数据（由 pinyin-pro 生成）
├── pages/index/
│   ├── index.wxml         # 上传区 / 模板 Tab / Canvas 预览 / 缩放 / 保存
│   ├── index.wxss         # 黑白灰极简样式
│   ├── index.js           # 业务流程 + 三种海报样式的 Canvas 绘制 + 3x 导出
│   └── index.json
└── tests/utils.test.js    # EXIF 解析 / URL 拼接 / 坐标转换的单元测试
```

## 使用前配置

1. 编辑 `utils/config.js`，填入 Mapbox Public Token（`pk.…`），可替换为自己在 Mapbox Studio 中制作的黑白样式（`username` / `styleId`）。
2. 小程序后台「服务器域名」中，把 `https://api.mapbox.com` 加入 `request` 与 `downloadFile` 合法域名（开发阶段可在开发者工具中勾选"不校验合法域名"）。
3. 把 `project.config.json` 的 `appid` 换成自己的 AppID。`wx.chooseLocation` 需要 `app.json` 中的 `requiredPrivateInfos`（已配置）。

未配置 token 时不会请求网络，海报使用本地绘制的简约底图，方便离线调试。

## 模板

| 样式 | 说明 |
| --- | --- |
| 拍立得 | 地图全屏背景 + 白边/投影相框，左上大字地名，坐标日期，底部衬线标语 |
| 上下分割 | 上 40% 地图 + 大字地名与坐标，下 60% 照片 |
| 地图徽章 | 照片全屏 + 底部渐变 + 圆形地图徽章与地名 |
| 杂志封面 | 全屏照片，超大衬线刊头地名 + 细线栏目，斜体封面标语，右下迷你地图 |
| 胶片 | 暗房底色，35mm 片基与齿孔，琥珀色相机背刻日期（`'24 06 16`），迷你地图格 |
| 明信片 | 纸张卡片 + 白边照片，`GREETINGS FROM` 地名，手写地址线，带齿孔邮票（迷你地图）与斜置邮戳、波浪消印 |
| 画廊展签 | 地图作墙面，黑框 + 白色卡纸装裱，博物馆式说明牌（地名 / 坐标 / 日期） |
| 玻璃卡片 | 全屏照片，日期胶囊，底部半透明深色玻璃面板含迷你地图与地名信息 |
| 巨字 | 全屏照片 + 镂空巨型地名描边，竖排标语，圆形迷你地图 |

所有模板都支持地图配色、地图 / 照片 / 文字不透明度；杂志封面、胶片、明信片、玻璃卡片、巨字以及上下分割、地图徽章支持照片取景调整（拍立得、画廊展签完整显示照片，无需裁切）。模板较多时顶部 Tab 可横向滑动。

## 导出

预览 Canvas 按屏幕 dpr 渲染；保存时使用页面外的隐藏 Canvas，物理尺寸 1200 × 1600（逻辑 400 × 533.33 的 3 倍），经 `wx.canvasToTempFilePath` 输出 JPG 并调用 `wx.saveImageToPhotosAlbum`。

## 说明与限制

- 必须选择原图（`sizeType: ['original']`），压缩图会丢失 EXIF；读取失败会提示并引导 `wx.chooseLocation` 手动选点（GCJ-02 会自动转换为 WGS-84）。
- 内置 EXIF 解析器取代 `exif-js`（后者依赖 DOM/XHR，无法在小程序中运行），支持 JPEG，并对 HEIC 做头部扫描兜底。
- 图片的 EXIF 方向（Orientation）目前依赖微信 Canvas 对图片的默认处理，未做额外旋转。

## 测试

```
node --test tests/utils.test.js
```
