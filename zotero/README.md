# Zotero 设置与可选阅读档案插件

## 建立「今日精选」入口

1. 在 Zotero 桌面端打开 **设置 → 同步**，登录 zotero.org 账号并启用数据同步。云端生成只需要同步条目和笔记。 [同步说明](https://www.zotero.org/support/preferences/sync)
2. 在 **我的文库** 下新建一个名为「今日精选」的分类。选中该分类，用工具栏的 **新建笔记 → 新建独立笔记**。第一行写 `今日精选｜YYYY-MM-DD`，把日期换成与根目录部署步骤中初始精选一致的日期。第二行起可写「看完这期后给这条笔记签到」。新一期会替换整条笔记，自己的阅读记录请另存。 [独立笔记说明](https://www.zotero.org/support/notes#standalone_notes)
3. 点击 Zotero 右上角同步按钮。打开 [Zotero 网页文库](https://www.zotero.org/)，登录同一账号，从 **Web Library** 打开该独立笔记。通常网址中 `/items/` 或 `/itemKey/` 后的八位字母数字串就是笔记条目 Key。把它用于根目录部署步骤，用户编号则从 [API 密钥设置](https://www.zotero.org/settings/keys) 查看。 [Web API 资源说明](https://www.zotero.org/support/dev/web_api/v3/basics#user_and_group_library_urls)

## 设置签到快捷键

1. 如果想同时管理论文阅读状态，先在任意论文条目上分别建立 `阅读：待读`、`阅读：在读`、`阅读：已读` 三个标签。然后在左下标签选择器逐个右键，选 **指定颜色（Assign Color）**，位置分别设为 `1`、`2`、`3`。以后给论文换状态时，先取消旧的状态标签，再加新标签。
2. 在独立笔记的标签栏临时加入 `精选：本期看过`。在左下角右键该标签，选择颜色和位置 `4`。新文库要有前三个颜色标签才会出现位置 `4`。也可以选其他可用位置，记下对应数字即可。配完后移除笔记上的签到标签，让它从未签到开始。
3. 每期看完后选中**中间列表里的精选笔记条目**，按分配的数字键，或手动加入同名标签。数字键会切换标签，请在同步前确认标签存在。脚本按标签识别签到，给其他论文加阅读状态或保存新论文都不会签到。 [Zotero 颜色标签说明](https://www.zotero.org/support/collections_and_tags/#colored_tags)

## 保存论文和本地 Markdown 草稿（可选）

通过 Zotero Connector 保存想读的论文。如果出版方允许并提供可用的 PDF，Connector 可以同时保存 PDF。状态筛选可用 **高级搜索 → 标签 → 是 → `阅读：待读`**，再点 **保存搜索**。其他状态同理。 [Zotero 收藏资料说明](https://www.zotero.org/support/adding_items_to_zotero) · [保存搜索说明](https://www.zotero.org/support/searching#saved_searches)

此目录的可选插件在 Zotero 10.0.x 个人文库的新 PDF 有本地文件及论文父条目时，为父条目添加 `科研学习档案.md`。已有同名附件时跳过。它在本地运行，与云端签到和推送独立。已有同类旧插件时，先停用旧插件，避免同时监听同一条导入。

从仓库根目录执行以下命令，使用 Python 3 自带的 ZIP 模块打包。

```sh
python zotero/build.py
```

在 Zotero 中打开 **工具 → 插件**，把 `zotero/dist/paper-digest-reading-draft.xpi` 拖到插件窗口。 [Zotero 插件安装说明](https://www.zotero.org/support/plugins)

模拟测试使用 Node.js 18 或更高版本。测试覆盖生成草稿、去重、延后到本地文件到位，以及停用插件后停止处理。

```sh
node --test zotero/test.cjs
```
