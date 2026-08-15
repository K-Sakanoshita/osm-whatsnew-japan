'use strict';

class OSMModal {
  constructor(dialog, {beforeOpen, afterClose, closeOnBackdrop = true} = {}) {
    this.dialog = typeof dialog === 'string' ? document.querySelector(dialog) : dialog;
    if (!(this.dialog instanceof HTMLDialogElement)) {
      throw new TypeError('OSMModal requires a dialog element.');
    }
    this.beforeOpen = beforeOpen;
    this.afterClose = afterClose;
    this.closeOnBackdrop = closeOnBackdrop;
    this.returnFocus = null;
    this.closeButton = this.createCloseButton();

    this.dialog.addEventListener('click', event => {
      if (this.closeOnBackdrop && event.target === this.dialog) this.close();
    });
    this.dialog.addEventListener('close', () => {
      const returnFocus = this.returnFocus;
      this.returnFocus = null;
      this.afterClose?.();
      requestAnimationFrame(() => returnFocus?.focus());
    });
    this.bindClose(this.closeButton);
  }

  open({returnFocus = document.activeElement, focusTarget} = {}) {
    if (this.dialog.open) return false;
    this.returnFocus = returnFocus;
    this.beforeOpen?.();
    this.dialog.showModal();
    focusTarget?.focus();
    return true;
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  bindClose(trigger) {
    const button = typeof trigger === 'string' ? this.dialog.querySelector(trigger) : trigger;
    button?.addEventListener('click', () => this.close());
  }

  createCloseButton() {
    const button = document.createElement('button');
    button.className = 'app-modal-close';
    button.type = 'button';
    button.setAttribute('aria-label', '閉じる');
    button.title = '閉じる';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    this.dialog.querySelector('.app-modal-heading')?.append(button);
    return button;
  }

  static createDialog({className = 'app-modal', labelledBy, describedBy, content}) {
    const dialog = document.createElement('dialog');
    dialog.className = className;
    dialog.setAttribute('aria-labelledby', labelledBy);
    if (describedBy) dialog.setAttribute('aria-describedby', describedBy);
    dialog.innerHTML = content;
    document.body.append(dialog);
    return dialog;
  }
}

window.OSMModal = OSMModal;
