// ---------------------------------------------------------------------------
// `tools/tsLoaderHook.mjs` を Node の module customization hooks API へ登録する
// ブートストラップ。`--import` で読み込む(hook 自身の中で自己登録すると
// hooks スレッドへの再帰ロードになるため、登録専用ファイルを分けてある)。
// ---------------------------------------------------------------------------

import { register } from "node:module";

register("./tsLoaderHook.mjs", import.meta.url);
