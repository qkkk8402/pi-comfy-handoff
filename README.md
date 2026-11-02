# pi-comfy-handoff

Pi coding agentからComfyUIのワークフローを編集し、画像・動画を生成します。GPUホストの管理プロセスがllama-serverとComfyUIのモデル切替を担当します。Piは同じホストでも、別マシン・仮想OSでも実行できます。

```text
Pi ── 推論・生成要求 ──> VRAM管理プロセス
                          ├─ llama-server
                          └─ ComfyUI
```

## GPUホストの準備

Node.js 22.19.0以上が必要です。llama-serverとComfyUIは、管理プロセスと同じGPUホストで起動してください。

```bash
llama-server --models-dir /path/to/models --no-models-autoload
```

管理プロセスはllama-serverのrouter APIを使います。両サーバーは通常どおり別途起動し、Piからの推論と生成は管理プロセスを経由させます。同じGPUを使う他クライアントの同時操作は避けてください。

リポジトリを取得して管理プロセスを起動します。

```bash
git clone https://github.com/qkkk8402/pi-comfy-handoff.git
cd pi-comfy-handoff
npm ci
npm run build
npm run manager
```

既定値は管理プロセスが`127.0.0.1:8090`、llama-serverが`http://127.0.0.1:8080`、ComfyUIが`http://127.0.0.1:8188`です。

起動時オプションで接続先などを上書きできます。

```bash
npm run manager -- --host 127.0.0.1 --port 8090 \
  --llama-url http://127.0.0.1:8080 \
  --comfy-url http://127.0.0.1:8188
```

すべてのオプションは`npm run manager -- --help`で確認できます。起動オプションはJSON設定より優先され、JSON設定は既定値より優先されます。JSONを使う場合は`--config manager.json`を指定します。
別ホストからPiを接続する場合は`--host`に公開するインターフェースを指定し、ホスト側に16文字以上の`COMFY_MANAGER_TOKEN`を設定し、Piの`/login llama.cpp`で同じトークンを入力してください。VRAM設定が必要な場合は`--gpu`と`--min-free-mib`を追加できます。

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 8090,
  "llamaServerUrl": "http://127.0.0.1:8080",
  "comfyuiUrl": "http://127.0.0.1:8188"
}
```

AMDではGPU指定に`"gpu": "card1"`、NVIDIAではインデックスやUUIDを使います。対象GPUが1枚なら自動検出します。`minFreeMiB`でLLM復帰時に必要な空きVRAMを指定できます。

`COMFY_MANAGER_TOKEN`を設定すると、管理プロセスへの接続にBearer認証を要求します。Piでは`/login llama.cpp`に管理プロセス用のトークンを入力してください。Pi側の`COMFY_MANAGER_TOKEN`設定は通常不要で、Piのログイン認証が一致する管理プロセスへ自動で共有されます。別ホストから接続する場合のネットワーク準備は利用環境側で行います。

llama-serverやComfyUI自身に認証を設定した場合、ホスト側の`LLAMA_API_KEY`・`COMFYUI_API_KEY`にそれぞれ設定します。

## Piの設定

拡張をインストールします。

```bash
pi install git:github.com/qkkk8402/pi-comfy-handoff
```

ソースを直接使う場合は、Piを次のように起動できます。

```bash
pi -e /path/to/pi-comfy-handoff/src/extension.ts
```

Piの推論接続も管理プロセスに向けます。

1. `/login llama.cpp`で`http://GPU_HOST:8090/llama`を登録する。
2. `/llama`でモデルをロードする。
3. `/model`で使用するモデルを選択する。
4. `/comfy setup`で管理プロセスのURL`http://GPU_HOST:8090`を登録する。

同一ホストなら`GPU_HOST`は`127.0.0.1`です。llama-serverへ直接接続すると、管理プロセスの推論制御を経由しません。
`/login llama.cpp`で保存したAPIキーは、認証時の`LLAMA_BASE_URL`が管理プロセスの`/llama`エンドポイントと一致するとき、ComfyUI操作にも自動で使われます。接続先が異なる場合はPiの認証キーを送らず、必要なら`COMFY_MANAGER_TOKEN`（または`apiKeyEnv`で指定した環境変数）を使います。同じ接続先ではPiのログインキーを優先し、未ログイン時は環境変数へフォールバックします。
初回の生成前に、Piの推論モデルを`/llama`でロードしてください。モデルが未ロードの生成要求は受理されず、同じ要求IDで再試行する前にモデルをロードする必要があります。

`/comfy setup`はプロジェクトの`.pi/comfyui.json`へ保存し、再起動なしで反映します。空Enterは現在値を維持し、Escは保存せず終了します。接続先を登録し直す場合は`/comfy reset`を実行し、新しい管理プロセスURLを入力します。空Enterで既定の`http://127.0.0.1:8090`に戻せます。どちらも生成中・復旧待ちの接続変更は拒否し、生成の復旧記録や他のプロジェクト設定は保持します。llama.cppのログインURLも変更する場合は、別途`/login llama.cpp`を実行してください。

JSONで設定する場合:

```json
{
  "managerUrl": "http://127.0.0.1:8090",
  "outputDir": "outputs/comfy"
}
```

`outputDir`と`stateDir`はPi側のパスです。`apiKeyEnv`でトークンを読む環境変数名を変更できます。JSONを手編集した場合はPiを再起動してください。

## ワークフローと生成

Pi拡張はノード仕様の取得、API形式ワークフローの作成・編集・検証、入力ファイルのアップロード、生成と出力ダウンロードを提供します。ワークフローはPi側プロジェクト内のJSONです。ComfyUI画面のキャンバス形式との同期や、モデルのダウンロードは対象外です。

例:

> ComfyUIのノード仕様を確認して、workflows/portrait.jsonをAPI形式で作成してください。検証して生成し、出力の保存先を教えてください。

生成要求はホスト側へ保存してから実行します。管理プロセスは新しい推論を止め、実行中の推論終了を確認し、LLMを解放して生成します。完了後にComfyUIを解放し、メモリ確認とLLM復帰を終えてから推論を再開します。

Piは短いHTTP要求で状態を繰り返し確認します。待機時間全体の上限は設けず、進捗を表示します。一時的な接続失敗では待機を継続します。待機中にPiの中断操作を行っても、ホストの生成は取り消しません。

生成結果は管理プロセス経由でPi側の`outputDir`へ保存します。共有フォルダーは不要です。

## 状態確認・再開・復旧

```text
/comfy status
/comfy resume
/comfy cancel
/comfy recover
/comfy connect MODEL_ID
```

- `status`: ホスト側の状態を確認します。
- `resume`: 保存した実行IDで待機と出力取得を再開します。生成は再送しません。
- `cancel`: ホスト側へ明示的に生成の取り消しを依頼します。
- `recover`: 状態不明の実行を確認し、解放・LLM復帰を試みます。
- `connect`: 指定LLMモデルをロードします。

Piの終了や通信切断によってホストの生成を取り消しません。Pi再起動後は`/comfy resume`を使えます。OS・外部ツールによるPiプロセスの強制終了そのものを防ぐ機能はありません。

管理プロセスが再起動した場合、未完了の実行は復旧待ちとし、生成を自動再送しません。状態が不明な間は推論と新しい生成を拒否します。

## VRAMの確認

ホスト側でGPU全体の総容量・使用量・空き容量を取得します。

- AMD/Linux: `amdgpu`ドライバーのsysfsを読み取ります。
- NVIDIA: `nvidia-smi`で取得します。
- ホスト統計を取得できない環境: ComfyUIのGPU統計を使います。

ホスト統計が利用できる場合は取得元と数値を状態表示に含めます。選択済みのホスト統計が途中で取得できなくなった場合は切替を止めます。モデルの解放状態、キュー、メモリ統計の安定と、設定されていれば空き容量の閾値を確認します。統計の安定だけでOOMを完全に防ぐことはできません。

AMD実機では、SDXLの512×512画像を8・64・192 stepsで生成し、その後のQwenモデル復帰と推論を確認しました。この確認は拡張のテストハーネスを使っており、Pi UIからの操作確認ではありません。NVIDIA実機では未確認です。

## 開発

```bash
npm run check
npm test
```
