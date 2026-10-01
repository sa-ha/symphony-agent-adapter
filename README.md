# symphony-agent-adapter

vanilla Symphony（[openai/symphony](https://github.com/openai/symphony) の Elixir 実装、および symphony-ts）を **fork せずに**、Codex 以外の coding agent を使うための薄い adapter です。

Symphony からは `codex app-server` に見えます。中で起動するのは Cursor Agent または Pi です。

```text
WORKFLOW.md
  codex.command: symphony-agent --kind cursor

vanilla Symphony
        ↓ stdio JSON-RPC
symphony-agent-adapter
        ├─ Cursor Agent CLI
        └─ Pi RPC
```

## 使い方

```bash
node src/cli.js --kind cursor
# または
node src/cli.js --kind pi
```

Symphony の `WORKFLOW.md` では `codex.command` だけ差し替えます。`agent.kind` を Symphony に追加する必要はありません。

```yaml
codex:
  command: node /path/to/symphony-agent-adapter/src/cli.js --kind cursor
```

```yaml
codex:
  command: node /path/to/symphony-agent-adapter/src/cli.js --kind pi
```

任意で CLI 本体を上書きできます。

```yaml
codex:
  command: node /path/to/symphony-agent-adapter/src/cli.js --kind cursor --command 'agent -p --output-format stream-json --trust --force'
```

Codex のまま使う場合は、従来どおりです。

```yaml
codex:
  command: codex app-server
```

## この adapter がやること

- agent 起動
- prompt / workspace の受け渡し
- 完了 / 失敗 / 取消の検知
- Cursor の `--resume`、Pi の同一 RPC session

## やらないこと

- model / provider / 認証の再実装（各 CLI の設定を使う）
- `linear_graphql` などの Codex dynamic tool の橋渡し
- Claude Code / Gemini などの他 agent
- Symphony 本体の改変

Cursor や Pi から Linear を使う場合は、各 CLI 側の MCP / 認証を使ってください。

## テスト

本物の Cursor / Pi API は呼びません。

```bash
node --test tests/*.test.js
```
