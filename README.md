# OSM What’s New Japan

OpenStreetMap本家APIの変更セットから、日本周辺で追加・編集されたタグ付き地物を収集し、地図と全国・都道府県別レポートとして表示するWebアプリケーションです。

## 主な機能

- 更新された地物をMapLibre地図とタイムスケールで再生
- 都道府県ミニマップと代表タグの種別選択による絞り込み、都道府県境界表示
- 全国および都道府県別の件数、代表タグ、マッパー、日別更新数の集計
- 全国の都道府県・マッパー・代表タグ・日別ランキングを更新レポートへ統合
- 期間、都道府県、マッパー、代表タグ、新規・更新種別によるAPI検索
- GeoJSON／CSVダウンロードと地図表示URLの共有

Webアプリケーションは `www/whatsnew/` にあります。

| ファイル | 役割 |
|---|---|
| `index.html` / `app.js` | 更新地図、タイムスケール、都道府県絞り込み |
| `details.html` / `details.js` | 全国・都道府県別の更新レポート |
| `site-info.js` | サイト概要、API説明、ソースコードへの共通案内モーダル |
| `api.php` | JSON APIの統合エンドポイント |
| `sync.php` | OSM変更セットを取得するCLI専用同期処理 |
| `schema.sql` | MySQLテーブルとAPI用インデックス |
| `data/` | カテゴリ、マーカー、都道府県GeoJSON |
| `tiles/` | MapLibre用OSMFJ POIスタイル |

## 必要環境

- PHP 8.0以上
- PDO MySQL、SimpleXML、mbstring、JSON拡張
- MySQLのJSON型を利用できるデータベース
- cronなど、`sync.php`を定期実行できる環境
- OSM API、地図タイル、MapLibre配信先へ接続できるネットワーク

このアプリケーションはPHPとMySQLを使用します。Pythonの `http.server` では `api.php` や `sync.php`を実行できません。

## セットアップ

### 1. 非公開設定

実際の接続情報は、Web公開ディレクトリの外に `private-osm-config.php` として配置します。このリポジトリ構成ではルートの `private-osm-config.php`を `www/whatsnew/bootstrap.php` が読み込みます。

別の場所へ置く場合は、環境変数 `OSM_APP_CONFIG` に絶対パスを指定します。

設定形式の例：

```php
<?php
return [
    'db' => [
        'host' => 'localhost',
        'dbname' => 'database_name',
        'user' => 'database_user',
        'pass' => 'database_password',
        'charset' => 'utf8mb4',
    ],
    'osm_api' => 'https://api.openstreetmap.org/api/0.6',
    'bbox' => '122.0,20.0,154.0,46.0',
];
```

`private-osm-config.php` は `.gitignore` の対象です。GitHubやWeb公開ディレクトリへ配置しないでください。

### 2. データベース

新規環境では `www/whatsnew/schema.sql` をMySQLへ適用します。

```shell
mysql -u database_user -p database_name < www/whatsnew/schema.sql
```

`CREATE TABLE IF NOT EXISTS` は既存テーブルの全列を自動更新しません。現在の `schema.sql` は、古いテーブルに対して `prefecture` 列と次の複合インデックスを重複なく追加します。

- `prefecture_timestamp (prefecture, osm_timestamp)`
- `editor_timestamp (editor_uid, osm_timestamp)`
- `category_value_timestamp (category, category_value, osm_timestamp)`

それ以前の構成から更新する場合は、バックアップを取得し、`osm_poi` の列をファイル先頭のテーブル定義と比較してから適用してください。`sync.php` は旧ENUM型の `category` と `category_value` をVARCHARへ拡張し、`prefecture` 列がない場合は追加します。

### 3. Webサーバー

公開環境では `www/whatsnew/` をPHP対応Webサーバーへ配置します。ローカル確認はリポジトリのルートで次のように起動できます。

```powershell
php -S localhost:8000 -t www/whatsnew
```

ブラウザーで `http://localhost:8000/` を開きます。

### 4. OSM同期

`sync.php` はWebアクセスを拒否し、CLIからのみ実行できます。

```powershell
php www/whatsnew/sync.php
```

初回は直近14日分から開始し、15分単位の時間窓でOSM変更セットを取得します。1回で最新まで到達しない場合は、次回実行時に保存済みカーソルから再開します。多重起動はロックファイルで防止されます。

同期処理は対象bbox内のタグ付き地物を保存します。タグがすべて削除された地物はDBから削除します。代表カテゴリは優先キーから1つ選びますが、全タグは `tags` JSONへ保存します。都道府県名は `data/prefectures.min.geojson` から判定します。

同期状態は `osm_sync_state` に保存されます。

| キー | 内容 |
|---|---|
| `sync_cursor_at` | 次回再開する取得位置 |
| `last_sync_at` | 最新まで同期できた日時 |

cronの実行間隔はサーバー環境に合わせて設定してください。各実行は最大約4分で終了し、前回処理中の場合は新しい実行をスキップします。

## API

APIエンドポイントは次の1つです。

```text
/whatsnew/api.php
```

GETパラメーターの `mode` で取得内容を指定します。省略時は `pois` です。

### 共通パラメーター

| パラメーター | 内容 |
|---|---|
| `mode` | `pois`、`japan`、`prefectures`、`facets` |
| `from` | 開始日（`YYYY-MM-DD`）。`to` と同時指定 |
| `to` | 終了日（`YYYY-MM-DD`）。指定日の終了までを対象 |
| `days` | `from`、`to`省略時の期間。`1`、`7`、`14`、`30`、`183`、`365`。既定値は`14` |
| `prefecture` | 都道府県名の完全一致（例：`愛知県`）。省略時は全国 |
| `editor_uid` | OSMマッパーのUID。互換用に `editorUid` も受付 |
| `editor_name` | OSMマッパー表示名の完全一致 |
| `category` | 同期時に選ばれた代表タグのキー（例：`shop`） |
| `category_value` | 代表タグの値（例：`convenience`）。`category` が必要 |
| `action` | `create` または `modify` |

任意の `tags` JSON検索には対応していません。日時はDB内とAPIではUTCを基準に扱い、ブラウザー画面ではJSTへ変換して表示します。

### POI一覧：`mode=pois`

```text
api.php?mode=pois&from=2026-07-01&to=2026-07-20&prefecture=愛知県
```

複合条件の例：

```text
api.php?mode=pois&days=30&prefecture=愛知県&editor_uid=793810&category=shop&category_value=convenience&action=modify
api.php?mode=pois&days=30&editor_name=mapper
```

追加パラメーター：

| パラメーター | 内容 |
|---|---|
| `limit` | 1回の取得件数。1～2000、既定値1000 |
| `cursor` | 続きを取得するための不透明なカーソル |

レスポンス例：

```json
{
  "meta": {
    "mode": "pois",
    "days": 14,
    "periodStart": "2026-07-01 00:00:00",
    "periodEnd": "2026-07-20 23:59:59",
    "filters": {
      "prefecture": "愛知県"
    },
    "limit": 1000,
    "nextCursor": "..."
  },
  "items": [
    {
      "type": "node",
      "id": "123456",
      "name": "店舗名",
      "type2": "shop",
      "kind": "convenience",
      "tags": "{...}",
      "lat": "35.0000000",
      "lon": "137.0000000",
      "prefecture": "愛知県",
      "date": "2026-07-20 01:23:45",
      "changeset": "123456789",
      "editorUid": "793810",
      "editorName": "mapper",
      "action": "modify"
    }
  ]
}
```

`meta.nextCursor` が `null` になるまで、返された値を同じ検索条件の `cursor` へそのまま渡します。

```text
api.php?mode=pois&from=2026-07-01&to=2026-07-20&prefecture=愛知県&cursor=返却された値
```

### 日本全国の集計：`mode=japan`

```text
api.php?mode=japan&days=30
api.php?mode=japan&days=30&prefecture=岐阜県
```

座標全件ではなく、DBで集計した次の結果を返します。

- `total`：対象地物総数
- `mappers`：マッパー別上位100件
- `changesetCount`：変更セット総数
- `changesets`：変更セット別上位100件
- `categories`：代表タグ別上位100件
- `daily`：選択期間の日別の新規・更新・合計
- `prefectures`：都道府県別上位100件

### 都道府県別件数：`mode=prefectures`

```text
api.php?mode=prefectures&from=2026-07-01&to=2026-07-20
```

`items` に都道府県名と件数を返します。都道府県を判定できない行は「日本国外・判定不能」にまとめます。

```json
{
  "meta": {
    "mode": "prefectures"
  },
  "items": [
    {"prefecture": "愛知県", "count": 808},
    {"prefecture": "岐阜県", "count": 291}
  ]
}
```

### 絞り込み候補：`mode=facets`

```text
api.php?mode=facets&days=30
api.php?mode=facets&days=30&prefecture=愛知県
```

対象期間と共通フィルター内の候補を返します。

- `mappers`：UID、表示名、件数（上位100件）
- `categories`：`category`、`category_value`、件数（上位500件）

### エラー

不正なクエリはHTTP 400、DB接続やテーブル不足などの内部エラーはHTTP 500で返します。

```json
{
  "error": "The date range is invalid.",
  "stage": "initialization"
}
```

## データと運用上の注意

- OSM由来データを利用する際はOpenStreetMapの著作権表示とライセンス条件に従ってください。
- `data/prefectures.min.geojson` は同期時の都道府県判定と各画面の境界表示に共用します。
- カテゴリ表示名とマーカー割り当ては `data/category-ja.jsonc`、`data/category-en.jsonc`、`data/marker.jsonc` で管理します。
- 定義ファイルは通常のブラウザーキャッシュを利用します。

## 更新履歴（ChangeLog）

### 2026-07-21

- サイト名を「OSM What’s New Japan」、説明文を「OpenStreetMapで更新された地物の検索・集計」へ変更し、共通ヘッダー、サイトロゴ、favicon、OG／Twitterメタデータを整備しました。
- `index.html` に都道府県ミニマップ、都道府県境界、期間・間隔指定のタイムスケール、再生・停止、共有URL、GeoJSONダウンロード、地物の新規／更新凡例を追加しました。
- ミニマップ直下に代表タグの種別フィルターを追加し、リスト、マーカー、クラスタ、タイムスケール、GeoJSON出力を同じ条件で絞り込めるようにしました。
- 共有URLで地図位置、ズーム、都道府県（ISO 3166-2）、開始日、終了日、再生間隔を復元し、共有URLを開いた場合は自動再生するようにしました。
- メインマップとミニマップのズーム・移動範囲、コントロール位置、読み込み表示、マーカー、ポップアップ、モバイル時の地図／リスト比率と余白を調整しました。
- 全国ランキングと都道府県別集計を `details.html` の更新レポートへ統合し、全国を初期表示として、地図から都道府県を選択できる構成へ変更しました。
- 更新地物数、新規／更新内訳、変更セット数、マッパー、代表タグ、日別件数、都道府県ランキングのグラフと表を整理し、編集件数が0の日も日別集計へ表示するようにしました。
- APIを `api.php` へ統合し、`mode=pois`、`mode=japan`、`mode=prefectures`、`mode=facets` を提供しました。期間、都道府県、マッパー、カテゴリ、カテゴリ値、新規／更新種別による絞り込みとカーソルページングに対応しました。
- 共通APIパラメーターへOSMマッパー表示名の完全一致検索 `editor_name` を追加しました。
- `sync.php` で `data/prefectures.min.geojson` を用いて都道府県を判定・保存し、APIレスポンスの都道府県を各画面で優先利用、空欄時はGeoJSONから補完するようにしました。
- `schema.sql` に既存テーブル向けの `prefecture` 列追加と、都道府県・マッパー・カテゴリ検索用の複合インデックスを追加しました。
- 都道府県GeoJSONをOSM由来タグへ統一し、沿岸・離島を含む判定範囲と共有境界を簡略化・調整しました。
- カテゴリ／マーカー定義を拡充し、amenity、barrier、craft、crossing、entrance、historic、leisure、man_made、office、playground、power、shopなどの主要キーに対応する表示名とアイコンを追加しました。
- 種別フィルターでは名称、標高、出典、アクセス条件などの補助タグを候補から除外し、地物種別を選びやすくしました。
- 画面別CSSを `style.css` へ統合し、共通ヘッダーやレスポンシブ表示で同じスタイルが適用される構成へ整理しました。
- ヘッダーのサイト名から、サイト概要とAPI・ソースコードを公開するGitHubリポジトリを案内するモーダルを表示できるようにしました。
