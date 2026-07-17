# ローカル版

`index.html`、`app.js`、`style.css` だけで構成した静的サイトです。

ブラウザの安全制限を避けるため、`index.html` を直接ダブルクリックする代わりに、このフォルダで簡易Webサーバーを起動して開いてください。

```powershell
python -m http.server 8000
```

次に `http://localhost:8000` を開きます。背景地図には同梱の `tiles/osmfj_poi.json`（OSMFJ POIスタイル）を使用します。インターネット接続は、本家OSM API・地図データ・MapLibreの読み込みに必要です。

`schema.sql` をMySQLへ一度だけ適用し、`sync.php` をサーバーのcronで15分ごとに実行してください。初回は本家OSM APIから直近14日分を小分けに取得し、1回で終わらない場合は次回実行時に保存済みの位置から再開します。追いついた後は前回同期以降の差分を取得します。`amenity` / `shop` のノードだけを保存し、画面は `api.php` から自前DBの結果だけを読みます。

同期途中の再開位置は `osm_sync_state.sync_cursor_at`、最新まで同期が完了した日時は `osm_sync_state.last_sync_at` に保存します。


この版はPHPとMySQLが必要です。Pythonの `http.server` では `api.php` を実行できません。さくらのPHP対応Webサーバーへ配置するか、ローカルにPHPを入れて `php -S localhost:8000` で起動してください。

実際の接続情報は、`www` と同じ階層に `private-osm-config.php` として置きます。アプリは `www/whatsnew/bootstrap.php` から2階層上の設定ファイルを読み込みます。環境変数 `OSM_APP_CONFIG` で別の絶対パスを指定することもできます。
