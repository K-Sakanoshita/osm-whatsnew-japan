(() => {
  const triggers = [...document.querySelectorAll('.site-info-trigger')];
  if (!triggers.length) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'site-info-dialog';
  dialog.setAttribute('aria-labelledby', 'site-info-title');
  dialog.innerHTML = `
    <div class="site-info-dialog-content">
      <button class="site-info-dialog-close" type="button" aria-label="閉じる" title="閉じる">×</button>
      <div class="site-info-dialog-heading">
        <img class="site-info-dialog-logo" src="image/site.png" width="480" height="480" alt="">
        <h2 id="site-info-title">OSM What’s New Japan</h2>
      </div>
      <p class="site-info-dialog-lead">OpenStreetMapで日本国内に追加・編集された地物を、地図とタイムスケールで検索し、全国・都道府県別に集計するWebアプリケーションです。</p>
      <p class="site-info-dialog-description">地物を取得するAPIの使い方、利用できるクエリパラメーター、セットアップ方法、ソースコードをGitHubで公開しています。</p>
      <a class="site-info-repository" href="https://github.com/K-Sakanoshita/osm-whatsnew-japan" target="_blank" rel="noopener noreferrer">
        <span>GitHubでAPIの使い方とソースコードを見る</span>
        <small>K-Sakanoshita/osm-whatsnew-japan ↗</small>
      </a>
      <p class="site-info-dialog-note">OpenStreetMapのデータはOpen Database License（ODbL）の下で提供されています。利用時は© OpenStreetMap contributorsの表示が必要です。</p>
    </div>
  `;
  document.body.append(dialog);

  let opener = null;
  const closeDialog = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  };

  triggers.forEach(trigger => {
    trigger.addEventListener('click', () => {
      opener = trigger;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  });
  dialog.querySelector('.site-info-dialog-close').addEventListener('click', closeDialog);
  dialog.addEventListener('click', event => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener('close', () => {
    opener?.focus();
  });
})();
