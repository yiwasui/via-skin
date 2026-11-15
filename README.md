# via-skin

Via 浏览器起始页皮肤（homepage.html + homepage.css）用的外置脚本。

`live2d.src.js` 是 Live2D 控制器：加载 live2d-widget、多 CDN 回退、拖动定位、
点按换形象、空闲预取下一个形象的资源。

皮肤页面里只留一段几百字节的 loader，从 jsDelivr 取这个文件：

```
https://fastly.jsdelivr.net/gh/yiwasui/via-skin@main/live2d.js
```

这样改脚本不用重新粘贴整个 homepage.html（Via 的皮肤编辑器只支持粘贴，
太长的文本贴不进去）。

## scripts/

`github-readme-zh.user.js` —— 独立的 Via 用户脚本（跟皮肤无关，别混）。
在 GitHub 的 README / Issue 正文每段下方插入中文译文，原文不动，右下角
「译」按钮开关。主源走必应、兜底 MyMemory。

安装地址（手机 Via 直接打开即可识别为脚本）：

```
https://fastly.jsdelivr.net/gh/yiwasui/via-skin@main/scripts/github-readme-zh.user.js
```

