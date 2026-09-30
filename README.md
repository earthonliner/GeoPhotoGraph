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

## 照片取景（上下分割 / 地图徽章）

这两个模板的照片是“铺满裁切”，可以自己决定用图片的哪一部分：
- 在预览图的照片区域**单指拖动**平移，**双指捏合**缩放；
- 或使用 PHOTO CROP 卡片中的「缩放（100%~400%）/ 左右 / 上下」滑块微调，「重置」恢复居中；
- 每个模板各自记忆取景，重新选择照片后重置；导出的海报与预览取景一致。
- 拍立得模板照片完整显示在相框内，不需要裁切。

## 地图配色与融合

- Mapbox 返回灰阶底图，配色在 Canvas 上完成：浅色主题「白底 → 地图 → multiply 主题色」，深色主题「黑底 → dark 样式地图 → screen 主题色」。地图不透明度为 0 时恰好是纯主题色。设备不支持混合模式时退化为半透明色罩。
- 推荐配色（低饱和、偏灰）：纸白 `#F3F1EC`、沙丘 `#E5D8C3`、鼠尾草 `#D3DBCC`、雾蓝 `#D2DCE6`、裸粉 `#EAD5CF`、灰紫 `#D9D3E0`；深色：午夜蓝 `#0F1B2D`、墨绿 `#10241C`、咖啡 `#2A1D17`、酒红 `#2B1218`、石墨 `#1B1C1F`。
- 自定义：点「+」色块，展开调色盘：拖动**饱和度/明度方块**与**色相条**取色，也可直接输入 HEX（如 `#E8DFD0`），两者实时同步；亮度低于阈值自动使用深色底图与浅色文字。（小程序没有原生取色器，调色盘由 view + CSS 渐变 + 触摸事件实现。）
- 地图 / 照片 / 文字三个不透明度滑块（0~100%）。三种模板都以整张地图为最底层，照片降低不透明度时会与地图融合。

## 日期（DATE）

默认取 EXIF 拍摄日期（没有则用今天）。点 DATE 一行会弹出日期选择器，海报实时更新为 `JUN 16, 2024` 格式；点「恢复拍摄日期」回到默认值。

## 地名（PLACE）

- 可直接在 PLACE 输入框手动修改，海报实时更新；点「恢复自动地名」回到自动结果。
- 支持 English / 中文 切换（默认 English）。英文模式下如果地图服务商没有英文名而返回汉字：汉字数 ≤ 4 转拼音（`北京` → `BEIJING`），更长则转首字母缩写（`中关村软件园` → `ZGCRJY`）。多音字地名（重庆、厦门、成都等）有特例表。

## 选点：为什么不换高德

`wx.chooseLocation` 是微信内置的腾讯地图选点，无法替换成高德，且高德 Web 服务（地理/逆地理编码）以中国境内为主，海外基本无数据，换了也解决不了海外定位。因此在配置 Mapbox token 后，「修改位置」提供两种方式：**搜索地点（全球，Mapbox 地理编码）** 与 **地图选点（微信地图，仅国内）**。

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
