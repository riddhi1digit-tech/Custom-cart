/*
 * Tiered free-gift cart synchronizer.
 * One event-driven manager replaces the theme's previous timers and polling.
 */
(function () {
  'use strict';

  if (window.__FREE_GIFT_MANAGER_V2__) return;
  window.__FREE_GIFT_MANAGER_V2__ = true;

  const nativeFetch = window.fetch.bind(window);
  const GIFT_PROPERTY = '_gift';
  const TIER_PROPERTY = '_gift_tier';
  const CART_MUTATION = /\/cart\/(add|change|update|clear)(\.js)?(?:\?|$)/;

  class FreeGiftManager {
    constructor() {
      this.isProcessing = false;
      this.queued = false;
      this.pendingCart = null;
      this.initialized = false;
      this.installCartInterceptor();
    }

    getConfig() {
      const settings = window.rewardSettings || {};
      const source = settings.tiers || {};
      return {
        enabled: settings.enabled !== false,
        tiers: [
          {
            tier: 3,
            threshold: Number(source.tier3?.threshold || 1999) * 100,
            variantId: Number(source.tier3?.variant_id || 42928272048199),
            label: source.tier3?.label || '1 CT Diamond Gift',
          },
          {
            tier: 2,
            threshold: Number(source.tier2?.threshold || 1499) * 100,
            variantId: Number(source.tier2?.variant_id || 42928272015431),
            label: source.tier2?.label || '0.75 CT Diamond Gift',
          },
          {
            tier: 1,
            threshold: Number(source.tier1?.threshold || 999) * 100,
            variantId: Number(source.tier1?.variant_id || 42928271982663),
            label: source.tier1?.label || '0.50 CT Diamond Gift',
          },
        ],
      };
    }

    installCartInterceptor() {
      const manager = this;
      window.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const responsePromise = nativeFetch(...args);

        if (CART_MUTATION.test(url) && !manager.isInternalRequest(args[1])) {
          responsePromise.then((response) => {
            response.clone().json().then((data) => {
              const cart = manager.isCartPayload(data) ? data : null;
              manager.requestSync(cart);
            }).catch(() => manager.requestSync());
          }).catch(() => manager.requestSync());
        }

        return responsePromise;
      };
    }

    isInternalRequest(options) {
      const headers = options?.headers;
      if (headers instanceof Headers) return headers.get('X-Free-Gift-Sync') === '1';
      return headers?.['X-Free-Gift-Sync'] === '1';
    }

    isCartPayload(data) {
      return Boolean(data && Array.isArray(data.items) && typeof data.total_price === 'number');
    }

    async fetchCart() {
      const response = await nativeFetch(`${window.Shopify?.routes?.root || '/'}cart.js`, {
        headers: { Accept: 'application/json', 'X-Free-Gift-Sync': '1' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`Cart request failed (${response.status})`);
      return response.json();
    }

    isGift(item, config = this.getConfig()) {
      if (!item) return false;
      if (String(item.properties?.[GIFT_PROPERTY]) === 'true') return true;
      if (item.properties?.[TIER_PROPERTY] != null) return true;
      const variantId = Number(item.variant_id || item.id);
      return config.tiers.some((tier) => tier.variantId === variantId);
    }

    subtotalWithoutGifts(cart, config = this.getConfig()) {
      return (cart.items || []).reduce((subtotal, item) => {
        if (this.isGift(item, config)) return subtotal;
        return subtotal + Number(item.final_line_price ?? item.line_price ?? 0);
      }, 0);
    }

    eligibleTier(subtotal, config = this.getConfig()) {
      return config.tiers.find((tier) => subtotal >= tier.threshold) || null;
    }

    requestSync(cart = null) {
      if (cart) this.pendingCart = cart;
      if (this.isProcessing) {
        this.queued = true;
        return this.currentSync;
      }

      // Clear the queued payload before sync starts. A no-op sync can complete
      // synchronously, so clearing it afterward would recursively queue itself.
      const nextCart = this.pendingCart;
      this.pendingCart = null;
      this.currentSync = this.sync(nextCart);
      return this.currentSync;
    }

    async sync(providedCart = null) {
      this.isProcessing = true;
      this.queued = false;

      try {
        const config = this.getConfig();
        let cart = providedCart || await this.fetchCart();
        const subtotal = this.subtotalWithoutGifts(cart, config);
        const desired = config.enabled ? this.eligibleTier(subtotal, config) : null;
        const gifts = (cart.items || []).filter((item) => this.isGift(item, config));
        const correctGifts = desired
          ? gifts.filter((item) => Number(item.variant_id || item.id) === desired.variantId)
          : [];

        this.updateProgress(subtotal, desired, config);

        const updates = {};
        gifts.forEach((item, index) => {
          const keep = desired && Number(item.variant_id || item.id) === desired.variantId && index === gifts.indexOf(correctGifts[0]);
          if (!keep) updates[item.key] = 0;
        });

        if (correctGifts[0] && Number(correctGifts[0].quantity) !== 1) {
          updates[correctGifts[0].key] = 1;
        }

        let finalResponse = null;
        if (Object.keys(updates).length) {
          finalResponse = await this.updateLines(updates);
          cart = this.isCartPayload(finalResponse) ? finalResponse : await this.fetchCart();
        }

        if (desired && !correctGifts.length) {
          finalResponse = await this.addGift(desired);
          cart = await this.fetchCart();
        }

        if (finalResponse?.sections) this.renderSections(finalResponse);
        this.updateProgress(this.subtotalWithoutGifts(cart, config), desired, config);
        document.dispatchEvent(new CustomEvent('free-gift:sync', { detail: { cart, tier: desired?.tier || 0 } }));
      } catch (error) {
        console.error('[Free gift] Unable to synchronize cart:', error);
      } finally {
        this.isProcessing = false;
        if (this.queued || this.pendingCart) {
          const nextCart = this.pendingCart;
          this.pendingCart = null;
          this.requestSync(nextCart);
        }
      }
    }

    async updateLines(updates) {
      const response = await nativeFetch(`${window.Shopify?.routes?.root || '/'}cart/update.js`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Free-Gift-Sync': '1' },
        body: JSON.stringify({
          updates,
          sections: ['cart-drawer', 'cart-icon-bubble'],
          sections_url: window.location.pathname,
        }),
      });
      if (!response.ok) throw new Error(`Gift removal failed (${response.status})`);
      return response.json();
    }

    async addGift(tier) {
      const response = await nativeFetch(`${window.Shopify?.routes?.root || '/'}cart/add.js`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Free-Gift-Sync': '1' },
        body: JSON.stringify({
          items: [{
            id: tier.variantId,
            quantity: 1,
            properties: { [GIFT_PROPERTY]: 'true', [TIER_PROPERTY]: String(tier.tier) },
          }],
          sections: ['cart-drawer', 'cart-icon-bubble'],
          sections_url: window.location.pathname,
        }),
      });
      if (!response.ok) throw new Error(`Gift addition failed (${response.status})`);
      return response.json();
    }

    renderSections(state) {
      if (!state.sections?.['cart-drawer'] && !state.sections?.['cart-icon-bubble']) return;
      const drawer = document.querySelector('cart-drawer');
      if (drawer?.renderContents && state.sections?.['cart-drawer']) {
        drawer.renderContents({ id: null, sections: state.sections });
        return;
      }

      const parser = new DOMParser();
      const drawerHtml = state.sections?.['cart-drawer'];
      if (drawerHtml) {
        const source = parser.parseFromString(drawerHtml, 'text/html').querySelector('#CartDrawer');
        const target = document.querySelector('#CartDrawer');
        if (source && target) target.innerHTML = source.innerHTML;
      }
    }

    updateProgress(subtotal, desired, config = this.getConfig()) {

  const tier1 = config.tiers.find((tier) => tier.tier === 1)?.threshold || 99900;
  const tier2 = config.tiers.find((tier) => tier.tier === 2)?.threshold || 149900;
  const tier3 = config.tiers.find((tier) => tier.tier === 3)?.threshold || 199900;

  let percent = 0;

  if (subtotal < tier1) {

    // Fill from Start -> Dot 1
    percent = (subtotal / tier1) * 33.333;

  } else if (subtotal < tier2) {

    // Stay exactly at Dot 1
    percent = 33.333;

  } else if (subtotal < tier3) {

    // Stay exactly at Dot 2
    percent = 66.666;

  } else {

    // Dot 3
    percent = 100;

  }

  document.querySelectorAll('.cart-drawer__rewards .progress-bar__fill').forEach((fill) => {
    fill.style.width = `${percent}%`;
  });

  document.querySelectorAll('.cart-drawer__rewards .progress-dot').forEach((dot, index) => {
    dot.classList.toggle('active', (desired?.tier || 0) >= index + 1);
  });

  const rewards = document.querySelector('.rewards-progress');
  if (rewards) {
    rewards.dataset.currentTier = String(desired?.tier || 0);
    rewards.dataset.cartSubtotal = String(subtotal);
  }
}

    // Compatibility aliases used by the theme's existing cart components.
    forceReAddGift() { return this.requestSync(); }
    forceCheckGift() { return this.requestSync(); }
    handleCartUpdateFromDOM() { return this.requestSync(); }
    handleCartUpdate(cart) { return this.requestSync(this.isCartPayload(cart) ? cart : null); }
    instantDomSync(cart) {
      if (!this.isCartPayload(cart)) return;
      const config = this.getConfig();
      const subtotal = this.subtotalWithoutGifts(cart, config);
      this.updateProgress(subtotal, this.eligibleTier(subtotal, config), config);
      this.requestSync(cart);
    }

    init() {
      if (this.initialized) return;
      this.initialized = true;
      this.requestSync();
      document.addEventListener('cart:update', () => this.requestSync());
      document.addEventListener('cart:refresh', () => this.requestSync());
      document.addEventListener('product:added', () => this.requestSync());
      document.addEventListener('ajaxCart:updated', () => this.requestSync());
    }
  }

  window.freeGiftManager = new FreeGiftManager();
  const init = () => window.freeGiftManager.init();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
