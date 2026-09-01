/**
 * One-time "enjoying this?" toast, shown bottom-right after a few successful
 * exports.
 *
 * Deliberately dark in both light and dark viewer themes: a toast is a
 * transient overlay, not page furniture, and a consistently dark chip reads as
 * something that arrived rather than something that was always there.
 *
 * The call to action is a real anchor rather than a button with a click
 * handler, so it behaves like a link — middle-click, modifier-click and
 * "copy link address" all work, and no popup blocker is involved.
 */
import { REVIEW_URL } from '@/core/review';

const MESSAGE =
  'Enjoying ScribblePDF? A quick 5-star review on the Chrome Web Store helps a lot! ⭐';

export class ReviewToast {
  readonly el: HTMLDivElement;
  private visible = false;

  constructor(private onShown?: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'pa-toast';
    this.el.hidden = true;
    // polite: it must never interrupt a screen reader mid-sentence.
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.build();
  }

  private build(): void {
    const text = document.createElement('p');
    text.className = 'pa-toast__text';
    text.textContent = MESSAGE;

    const actions = document.createElement('div');
    actions.className = 'pa-toast__actions';

    const review = document.createElement('a');
    review.className = 'pa-toast__cta';
    review.href = REVIEW_URL;
    review.target = '_blank';
    review.rel = 'noopener noreferrer';
    review.textContent = 'Leave a Review';
    review.addEventListener('click', () => this.dismiss());

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'pa-toast__later';
    later.textContent = 'Not now';
    later.addEventListener('click', () => this.dismiss());

    actions.append(review, later);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pa-toast__close';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
      ' stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/></svg>';
    close.addEventListener('click', () => this.dismiss());

    this.el.append(close, text, actions);
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.el.hidden = false;

    // No requestAnimationFrame here, deliberately. rAF callbacks are throttled
    // (and in a backgrounded tab, not run at all), which would leave the toast
    // permanently at opacity 0 with its reveal class never applied. Positioning
    // uses the layout box, so it needs no frame; and reading offsetHeight forces
    // the style flush that gives the CSS transition a starting point.
    this.avoidToolbar();
    void this.el.offsetHeight;
    this.el.classList.add('is-visible');

    window.addEventListener('resize', this.onResize);
    this.onShown?.();
  }

  private onResize = (): void => {
    if (this.visible) this.avoidToolbar();
  };

  /**
   * Keep clear of the floating toolbar.
   *
   * A CSS breakpoint cannot do this: the toolbar is centred *and* draggable, so
   * whether the two collide depends on where the user left it, not just on the
   * viewport width. Measure instead, and lift the toast above the toolbar only
   * when it would actually overlap.
   */
  private avoidToolbar(): void {
    this.el.style.bottom = '';
    const toolbar = document.querySelector('.pa-toolbar');
    if (!toolbar) return;

    const bar = toolbar.getBoundingClientRect();

    // Derive the toast box from its layout size and CSS insets rather than
    // getBoundingClientRect(). The entry animation applies a translateY that is
    // still in effect when this runs, so a rect-based measurement silently
    // depends on which frame it lands in — it produced the right answer only
    // once a resize happened to re-run it.
    const style = getComputedStyle(this.el);
    const rightInset = Number.parseFloat(style.right) || 0;
    const bottomInset = Number.parseFloat(style.bottom) || 0;
    const right = window.innerWidth - rightInset;
    const left = right - this.el.offsetWidth;
    const bottom = window.innerHeight - bottomInset;
    const top = bottom - this.el.offsetHeight;

    const overlaps = left < bar.right && right > bar.left && top < bar.bottom && bottom > bar.top;
    if (overlaps) this.el.style.bottom = `${window.innerHeight - bar.top + 12}px`;
  }

  dismiss(): void {
    if (!this.visible) return;
    this.visible = false;
    window.removeEventListener('resize', this.onResize);
    this.el.classList.remove('is-visible');
    const hide = (): void => {
      this.el.hidden = true;
    };
    // Wait out the exit transition, but do not depend on it firing.
    this.el.addEventListener('transitionend', hide, { once: true });
    window.setTimeout(hide, 400);
  }

  get isVisible(): boolean {
    return this.visible;
  }
}
