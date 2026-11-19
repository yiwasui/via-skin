# 自托管 Live2D 模型

## 现在在用的是 Cubism 4（moc3）

`haru` / `hiyori` / `mao` / `rice` 四个，全部来自 **Live2D 官方样例库**
（`github.com/Live2D/CubismWebSamples`，`Samples/Resources/`），由 `../_c4pack.py` 打包：

- 贴图 PNG → WebP(q=88)，路径改成 `textures/NN.webp`（Haru 2.7MB → 0.44MB）
- 动作只留 `Idle` 全量 + 其他组前 2 条，表情全留
- `.cdi3.json` / `.userdata3.json` / `sounds/` 丢掉，**引用键也一起删**
  （只删文件不删键 → pixi-live2d-display 去拉 404，报笼统的 "Unknown error"，Mao 栽过）
- 模型自包含：目录里只有相对引用，整包搬到别处也能跑

包大小：haru 0.89M / hiyori 1.09M / rice 1.31M / mao 1.50M

**授权**：官方样例库标注「無料配布」，条款允许一般用户和小规模事业者自由公开、
分发、销售（**unity-chan 与初音ミク除外**，这两个别往仓库里放）。

**渲染**：`live2d.src.js` 走 pixi 6 + `pixi-live2d-display@0.4.0`（cubism4 版）+
**官方 CDN 的最新 core**（`cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`）。
npm 上的 `live2dcubismcore@1.0.x` 是 2019 年的 Cubism 4 core，读新样例报 "Unknown error"。

## 旧的 Cubism 2（moc / index.json）

`murakumo` / `nepgear` 是 2026-11-18 从社区库（fghrsh/live2d_api）挪过来的，
**当前引擎读不了，只作为回退备份留在仓库里**。当年为绕过 jsDelivr 的做法：

- **`textures/*.png` 里装的其实是 WebP**。jsDelivr 对 `.webp` 会 301 到
  raw.githubusercontent（国内不通），所以内容不改、只改后缀，靠浏览器嗅探解码。
- 跨目录引用（nepgear 的 `../general/pose.json`）已复制进各自目录并改写。

字形与版权：murakumo（舰C 丛云）、nepgear（海王星）均为同人/拆包素材，仅自用。
