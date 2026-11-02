# pi-comfy-handoff

Pi coding agent の拡張から ComfyUI のワークフローを編集し、画像・動画を生成します。Pi は `llama-server` に接続し、拡張は両サーバーの HTTP API を直接呼び出します。

```text
Pi ──推論────────────────────> llama-server
  └─拡張 ──モデル解放・復帰──> llama-server API
          └─編集・検証・生成──> ComfyUI API
```

## 前提

- Node.js 22以上と Pi coding agent。
- モデルのロード・アンロードAPIを提供する llama.cpp `llama-server`。
- ComfyUI の HTTP API。生成中に同じGPUを使う他クライアントが操作しない運用。
- Pi から両方のAPIへ接続できること。ローカル、別マシン、仮想OSのいずれでも、到達可能なURLを設定します。

接続先サーバーの準備とネットワーク設定は利用環境側で行います。llama-serverのrouterモードを使い、拡張がLLMとComfyUIのモデルを交互にロードします。

## セットアップ

### 1. インストール

```bash
pi install git:github.com/qkkk8402/pi-comfy-handoff
```

ソースから開発する場合:

```bash
npm ci
npm run build
```

### 2. サーバー起動

llama-server の router モードで自動ロードを無効にします。使用している llama.cpp 版でオプションとモデル管理APIを確認してください。

```bash
llama-server --models-dir /path/to/models --no-models-autoload
```

モデルIDは `GET /models` が返す値を使います。ComfyUIも通常どおり起動してください。

### 3. 接続設定

Piを実行するプロジェクトの `.pi/comfyui.json` に、2つのURLを設定します。

```json
{
  "comfyuiUrl": "http://127.0.0.1:8188",
  "llamaServerUrl": "http://127.0.0.1:8080"
}
```

別マシンや仮想OSでは、Piから到達できるホスト名/IPアドレスとポートを指定します。URLはネイティブAPIのルートを指定します（リバースプロキシのパスprefixは使用可能です）。llama-serverのURLに推論用の `/v1` は付けません。拡張が必要なAPIパスを追加します。設定変更はPiの再起動で反映します。

任意設定を使う場合:

```json
{
  "comfyuiUrl": "http://127.0.0.1:8188",
  "llamaServerUrl": "http://127.0.0.1:8080",
  "outputDir": "outputs/comfy",
  "stateDir": ".pi/comfy-state",
  "llamaModel": "MODEL_ID",
  "minFreeMiB": 1024
}
```

`outputDir`と`stateDir`はPi側のパスです。対象モデルは利用中のPiモデルIDを使用し、PiのIDがない場合は `llamaModel` または一意にロードされているモデルから解決します。認証が必要なら、環境変数 `COMFYUI_API_KEY`、`LLAMA_API_KEY` にBearerトークンを設定します。別の変数名を使う場合は設定の `comfyApiKeyEnv`、`llamaApiKeyEnv` で指定できます。`timeouts` には `requestMs`、`modelMs`、`generationMs`、`settleMs`、`pollMs` を任意設定できます。

### 4. Piを llama-server へ接続

Piの `~/.pi/agent/models.json` に OpenAI互換 provider を設定します。providerの `baseUrl` は `llamaServerUrl` に `/v1` を足した値です。モデルID、コンテキスト長、最大出力は使用モデルに合わせてください。

```json
{
  "providers": {
    "llama-local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "no-key",
      "models": [{
        "id": "MODEL_ID",
        "name": "Local llama-server",
        "reasoning": false,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 32768,
        "maxTokens": 4096
      }]
    }
  }
}
```

APIキーを使う場合は、Piのprovider設定と拡張の接続設定の両方でサーバーの要件に合わせます。拡張はPiの推論リクエストを中継しません。Pi標準のOpenAI互換providerを使います。

Piでproviderのモデルを選びます。ソースから直接使う場合は、拡張を指定して起動します。

```bash
pi -e /path/to/pi-extension/src/extension.ts
```

モデルが未ロードなら、LLMを使わないコマンドで接続・初期ロードします。

```text
/comfy connect MODEL_ID
```

## 使い方

拡張はノード仕様の取得、API形式ワークフローの作成・編集・検証、入力ファイルのアップロード、画像・動画の生成を提供します。ワークフローはPi側プロジェクトのJSONとして保存します。ComfyUI画面のキャンバス形式との同期・自動変換や、モデルのダウンロードは行いません。

生成例:

> ComfyUIのノード仕様を確認して、workflows/portrait.jsonをAPI形式で作成してください。検証後に生成し、出力ファイルの保存先を教えてください。

生成時は、Piのツール処理がLLM推論を一時停止し、拡張が対象モデルをアンロードしてComfyUIへジョブを送ります。完了後にComfyUIへ解放を要求し、APIから確認できる状態を待ってからLLMをロードします。モデル復帰を確認した後で結果をPi側へ返します。バッチ生成では同じ切替をまとめて行います。

ComfyUIの生成結果はAPI経由でPi側の `outputDir` に保存します。入力ファイルもPi側からアップロードします。共有フォルダーやホスト側パスへのアクセスは必要ありません。

## コマンドと復旧

生成の前後に、LLMを使わず状態確認や復旧を行えます。

```text
/comfy status
/comfy cancel
/comfy recover
```

`/comfy status` は保存された実行状態を表示します。`/comfy connect MODEL_ID` はllama-serverへモデルをロードします。生成失敗・キャンセル後は、対象ジョブが停止したことを確認してから解放とモデル復帰を行います。生成POSTの応答が不明な場合は二重生成を避けるため自動再送せず、状態を保存して手動復旧を求めます。明示的なrecoverでqueueが空と確認できた場合は解放と復帰を試みますが、結果不明の生成を成功扱いにしたり再実行したりしません。

Piや仮想OSを強制終了した場合、サーバー側の後始末は保証されません。再起動後に `/comfy status` で状態を確認し、必要なら `/comfy recover` を実行します。サーバーの起動・停止やネットワーク復旧は拡張では行いません。

## VRAMとGPU

LLMはllama-serverのモデル管理API、生成モデルはComfyUI APIで切り替えます。ComfyUIの `/system_stats` などから利用可能なVRAM情報を確認します。`/free`の成功応答だけでは、GPUメモリが解放されたとは判断しません。

メモリ確認には、CUDA/ROCmでComfyUIが `type: cuda` として提供する統計を使用します。未対応・不正な統計ではLLM復帰を見送って復旧待ちになります。統計の安定だけでは必要な空き容量を保証しないため、必要に応じて `minFreeMiB` を設定します。APIだけでカスタムノード等の全メモリ解放を保証することはできません。

モックHTTPサーバーによるテストを実施しています。実GPUでの動作確認は未実施です。

## 開発

```bash
npm run check
npm test
```
