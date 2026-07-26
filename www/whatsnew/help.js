(() => {
  const trigger = document.querySelector('#map-guide-open');
  if (!trigger) return;

  const STORAGE_KEY = 'osm-whatsnew-guide-v1';
  const dialog = document.createElement('dialog');
  dialog.id = 'map-guide-dialog';
  dialog.className = 'map-guide-dialog';
  dialog.setAttribute('aria-labelledby', 'map-guide-title');
  dialog.setAttribute('aria-describedby', 'map-guide-intro');
  dialog.innerHTML = `
    <div class="map-guide-panel">
      <div class="map-guide-header">
        <div class="map-guide-title">
          <img src="image/site.png" width="480" height="480" alt="">
          <h2 id="map-guide-title">OSM What’s New Japanについて</h2>
        </div>
        <button class="map-guide-close" type="button" aria-label="ガイドを閉じる" title="閉じる">×</button>
      </div>
      <div class="map-guide-body">
        <p id="map-guide-intro" class="map-guide-intro">OpenStreetMapで日本国内に追加・編集された地物を、地図とタイムスケールで検索し、全国・都道府県別に集計するWebアプリケーションです。</p>
        <ul class="map-guide-list">
          <li><span class="map-guide-marker is-create" aria-hidden="true"></span><span><strong>緑のピン</strong>OSMに新規作成された地物</span></li>
          <li><span class="map-guide-marker is-modify" aria-hidden="true"></span><span><strong>オレンジのピン</strong>既存地物の更新</span></li>
          <li><span class="map-guide-symbol" aria-hidden="true">▶</span><span><strong>タイムスケール</strong>更新された時刻に沿って地図を再生</span></li>
          <li><img class="map-guide-image" src="image/map.png" width="1254" height="1254" alt=""><span><strong>都道府県</strong>対象地域を絞り込み</span></li>
          <li><img class="map-guide-image" src="image/report.png" width="1254" height="1254" alt=""><span><strong>更新レポート</strong>タグ、編集者、日付、変更セット別に集計</span></li>
        </ul>
        <p class="map-guide-note"><strong>時刻について</strong>OSMへの登録・更新時刻を示すもので、施設の開業日や現実世界での変更日を示すものではありません。</p>
        <p class="map-guide-scope">タグ付きノードに加え、対象タグを持つwayとmultipolygon relationを対象としています。</p>
        <section class="map-guide-about" aria-label="APIとライセンス">
          <p class="map-guide-about-description">地物を取得するAPIの使い方、利用できるクエリパラメーター、セットアップ方法、ソースコードをGitHubで公開しています。</p>
          <a class="site-info-repository map-guide-repository" href="https://github.com/K-Sakanoshita/osm-whatsnew-japan" target="_blank" rel="noopener noreferrer">
            <span>GitHubでAPIの使い方とソースコードを見る</span>
            <small>K-Sakanoshita/osm-whatsnew-japan ↗</small>
          </a>
          <p class="map-guide-license">OpenStreetMapのデータはOpen Database License（ODbL）の下で提供されています。利用時は© OpenStreetMap contributorsの表示が必要です。</p>
        </section>
      </div>
      <div class="map-guide-actions"><button class="map-guide-start" type="button">地図を見る</button></div>
    </div>
  `;
  document.body.append(dialog);

  let openMode = '';
  let returnFocus = trigger;

  function hasSeen() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  function rememberSeen() {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Storage may be unavailable in private or restricted browsing contexts.
    }
  }

  function open({mode = 'manual', focusTarget = trigger} = {}) {
    if (dialog.open) return;
    openMode = mode;
    returnFocus = focusTarget || trigger;
    dialog.dispatchEvent(new CustomEvent('osm-guide-before-open', {detail: {mode}}));
    dialog.showModal();
    dialog.querySelector('.map-guide-close').focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  trigger.addEventListener('click', () => open());
  dialog.querySelector('.map-guide-close').addEventListener('click', close);
  dialog.querySelector('.map-guide-start').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    const closedMode = openMode;
    const focusTarget = returnFocus;
    openMode = '';
    returnFocus = trigger;
    if (closedMode === 'automatic') rememberSeen();
    dialog.dispatchEvent(new CustomEvent('osm-guide-closed', {detail: {mode: closedMode}}));
    requestAnimationFrame(() => focusTarget?.focus());
  });

  window.osmWhatsNewGuide = {dialog, hasSeen, open, close};
})();
