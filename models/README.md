# 自托管 Live2D 模型

这两个不是 npm 包，是从社区库（fghrsh/live2d_api）挪过来的，贴图做过处理：

- **`textures/*.png` 里装的其实是 WebP**。原图 PNG 合计 3.4MB，转 WebP 质量 88 后 0.6MB。
  但 jsDelivr 对 `.webp` 扩展名会 301 到 raw.githubusercontent（国内不通），
  所以内容不改、只把后缀改成 `.png`——浏览器按内容嗅探解码，Chromium 实测正常。
  要换图请保持这个做法，或改回真 PNG 并接受体积。
- 跨目录的引用（nepgear 的 `../general/pose.json`、`../../general/mtn/*.mtn`）已复制进各自目录并改写相对路径，模型自包含。

字形与版权：murakumo（舰C 丛云）、nepgear（海王星）均为同人/拆包素材，仅自用。
