# 安装

## 你需要什么

- Node.js ≥ 22（用到内置的 `node:sqlite`）
- DeepSeek Harness（这套东西是给它用的）
- 一个 LLM API（提炼和验证要用）
- 一个 embedding 服务（二选一）：
  - 本地跑 bge-m3（免费，但要装模型）
  - 任意 OpenAI 兼容的 embedding API

## 一、拉代码

```bash
git clone https://github.com/Wheatear03/dsh-memory-system.git
cd dsh-memory-system
```

## 二、配置

```bash
cp config.example.json config.json
```

编辑 `config.json`，至少填这两项：

```json
{
  "llm": {
    "apiKey": "sk-..."
  },
  "embedding": {
    "type": "local",
    "baseUrl": "http://127.0.0.1:8090"
  }
}
```

`config.json` 已经在 `.gitignore` 里，不会被提交。

### 关于 embedding

**本地 bge-m3（推荐）**

需要自己起一个 OpenAI 兼容的 embeddings 服务。项目里 `service/embed-server.py` 是参考实现：

```bash
pip install fastapi uvicorn sentence-transformers
python service/embed-server.py
# 默认监听 8090
```

第一次启动会下载模型（约 2.2G），之后加载约 1-2 分钟。

**外部 API**

把 `embedding.type` 改成 `openai`，填 `baseUrl` 和 `apiKey`。任何兼容 `/v1/embeddings` 的服务都行。

## 三、初始化

```bash
node src/engine.mjs init
node src/engine.mjs health
```

## 四、装插件

插件在 `plugin/` 目录。它需要被 DSH 加载，有两种方式：

**方式 A：link 进 profile（开发用）**

在你的 profile `package.json` 的 `dependencies` 里加：

```json
"dsh-memory-system": "link:/绝对路径/dsh-memory-system/plugin"
```

然后：

```bash
cd <profile目录>
pnpm install
```

重启 DSH。

**方式 B：直接改 profile 的 cordis.patch.yml**

```yaml
- insert:
    - id: memory-system
      name: dsh-memory-system
```

（需要插件模块能被解析到，所以通常还是配合 link 用）

## 五、验证

重启 DSH 后，看插件日志里有没有：

```
注入点挂上了
```

然后随便聊一句，再问它「我们刚才聊了什么」——如果它能答上来，就通了。

## 常见问题

**Q: 插件报 `Cannot find package`**

插件是 ESM，依赖必须能解析。用 `link:` 方式装进 profile 的 `node_modules` 里，不要直接指向源码目录。

**Q: 检索总是返回空**

1. 看 `node src/engine.mjs health` 有没有数据
2. 看 embedding 服务通不通：`curl http://127.0.0.1:8090/`
3. 调低 `config.json` 里的 `recall.minCue` 试试

**Q: 提炼出来的东西不对**

改 `prompts/extract.txt`。提示词是独立文件，改文本不用动代码。

**Q: 想清空重来**

删掉 `~/.dsh-memory/` 目录，重新 `init`。
