// --- Russian live log channel (open /logs.html or use the phone-mode "Логи" button) ---
const Logger = {
    _chan: null,
    init() {
        try {
            this._chan = new BroadcastChannel('game_logs');
        } catch (e) { this._chan = null; }
        window.addEventListener('error', (e) => this.log('error', 'JS: ' + (e.message || e)));
        window.addEventListener('unhandledrejection', (e) => this.log('error', 'Promise: ' + (e.reason && e.reason.message || e.reason)));
        this.log('info', 'Приложение запущено');
    },
    log(type, msg) {
        try {
            if (this._chan) this._chan.postMessage({ type, msg });
        } catch (e) {}
        // Keep a small on-screen badge count of errors
        if (type === 'error') {
            const badge = document.getElementById('log-error-badge');
            if (badge) {
                const n = parseInt(badge.textContent || '0', 10) + 1;
                badge.textContent = n;
                badge.style.display = 'flex';
            }
        }
    },
    click(reward) { this.log('click', `Клик засчитан: +${reward}`); },
    api(method, path, ok, ms) { this.log('api', `${method} ${path} ${ok ? 'OK' : 'ОШИБКА'} (${ms} мс)`); },
    success(msg) { this.log('success', msg); },
    warn(msg) { this.log('warn', msg); }
};

const App = {
    currentScreen: 'home',
    passiveInterval: null,
    energyInterval: null,
    clickCooldown: false,
    lastClickTime: 0,

    async init() {
        // Check force relogin - only if no token exists
        if (localStorage.getItem('force_relogin') && !localStorage.getItem('session_token')) {
            localStorage.removeItem('force_relogin');
            this.showAuthScreen();
            return;
        }
        localStorage.removeItem('force_relogin');

        this.showLoading('Авторизация...');
        Logger.init();
        
        // Telegram Mini App auto-login: exchange initData for a session token.
        if (this.inTelegram()) {
            try { window.Telegram.WebApp.ready(); window.Telegram.WebApp.expand(); } catch (e) {}
            await this.tryTelegramLogin();
        }
        
        const authed = await Auth.init();
        Logger.log('info', authed ? 'Авторизация успешна' : 'Не авторизован');
        
        // Hide loading
        document.getElementById('loading-screen').classList.add('hidden');
        
        if (!authed) {
            this.showAuthScreen();
            return;
        }

        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app-shell').style.display = 'block';
        document.getElementById('dock').style.display = 'flex';

        this.setupNavigation();
        this.setupClicker();
        this.applyBackground();
        this.showScreen('home');
        this.startIntervals();
        this.updateAllUI();
        
        // Admin gear
        if (Auth.user && Auth.user.is_admin) {
            document.getElementById('admin-gear-btn').style.display = 'inline';
            document.getElementById('profile-admin-gear').style.display = 'inline';
            const logBtn = document.getElementById('log-btn');
            if (logBtn) logBtn.style.display = 'inline';
        }
        
        // Start online counter
        this.startOnlineCounter();
        
        // Refresh user data when the tab regains focus (e.g. after the admin
        // panel granted coins in another tab) so balances update immediately.
        window.addEventListener('focus', () => this._syncFromServer());
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this._syncFromServer();
        });
        
        // Start particles
        Particles.init();
    },
    
    showAuthScreen() {
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('auth-loading-overlay').style.display = 'none';
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('app-shell').style.display = 'none';
        document.getElementById('dock').style.display = 'none';
        document.getElementById('more-sheet').classList.remove('open');
        document.body.classList.remove('bg-applied');
        document.body.style.background = '';
        
        // Inside Telegram we never show the manual login screen. Automatic
        // login already ran once in init(); on failure, wait for a manual
        // retry instead of reloading forever and flooding the backend.
        if (this.inTelegram()) {
            document.getElementById('auth-telegram-wrap').innerHTML =
                '<div class="auth-auto-msg">Не удалось подключиться через Telegram.</div>' +
                '<button id="auth-telegram-retry" class="auth-trigger-btn">Повторить вход</button>';
            const retry = document.getElementById('auth-telegram-retry');
            retry.addEventListener('click', async () => {
                retry.disabled = true;
                retry.textContent = 'Подключение...';
                const ok = await this.tryTelegramLogin();
                if (ok) {
                    window.location.reload();
                    return;
                }
                document.getElementById('loading-screen').classList.add('hidden');
                retry.disabled = false;
                retry.textContent = 'Повторить вход';
            });
            return;
        }

        // Don't auto-load any widget - the auth screen is only a fallback for a
        // plain browser (dev) where there is no Telegram initData.
        const wrap = document.getElementById('auth-telegram-wrap');
        wrap.innerHTML = `<button id="auth-login-trigger" class="auth-trigger-btn">🔑 Войти через Telegram</button>`;
        
        const trigger = document.getElementById('auth-login-trigger');
        if (trigger) {
            const newTrigger = trigger.cloneNode(true);
            trigger.parentNode.replaceChild(newTrigger, trigger);
            newTrigger.addEventListener('click', (e) => {
                e.preventDefault();
                this.openTelegramMiniApp();
            });
        }
    },

    showLoading(text) {
        const el = document.getElementById('loading-text');
        if (el && text) el.textContent = text;
        document.getElementById('loading-screen').classList.remove('hidden');
    },

    inTelegram() {
        return !!(window.Telegram && window.Telegram.WebApp &&
            (window.Telegram.WebApp.initData || window.Telegram.WebApp.initDataUnsafe));
    },

    async tryTelegramLogin() {
        const tg = window.Telegram.WebApp;
        if (!tg || !tg.initData) return false;
        this.showLoading('Вход через Telegram...');
        try {
            const res = await API.post('/api/auth/login', { init_data: tg.initData });
            if (res && res.token) {
                localStorage.setItem('session_token', res.token);
                localStorage.setItem('user_id', String(res.user_id));
                return true;
            }
        } catch (e) {
            Logger.log('error', 'Telegram login: ' + (e && e.message || e));
        }
        return false;
    },

    setupNavigation() {
        // Track touch so that swipe gestures (which the browser turns into a
        // synthetic 'click' on some mobile browsers) don't trigger navigation.
        this._tapActive = true;
        this._touchStart = null;
        this._lastTapAt = -1;
        this._lastTapActive = false;
        this._lastScrollAt = 0;
        document.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            this._touchStart = t ? { x: t.clientX, y: t.clientY } : null;
            this._tapActive = true;
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            if (t && this._touchStart) {
                const d = Math.hypot(t.clientX - this._touchStart.x, t.clientY - this._touchStart.y);
                if (d > 10) this._tapActive = false;
            }
        }, { passive: true });
        document.addEventListener('touchend', (e) => this._captureTouchEnd(e), { passive: true });
        document.addEventListener('touchcancel', (e) => this._captureTouchEnd(e), { passive: true });
        // Any scroll during a gesture means it was a swipe, not a tap. Some
        // browsers coalesce fast flicks into only touchstart/touchend (no
        // touchmove), so the scroll alone must invalidate the pending click.
        document.addEventListener('scroll', () => {
            this._lastScrollAt = Date.now();
            this._tapActive = false;
        }, { passive: true, capture: true });

        document.querySelectorAll('.dock-item').forEach(item => {
            item.addEventListener('click', () => {
                if (!this._wasTap()) return;
                const screen = item.dataset.screen;
                this.showScreen(screen);
            });
        });

        document.querySelectorAll('.more-item').forEach(item => {
            item.addEventListener('click', () => {
                if (!this._wasTap()) return;
                const screen = item.dataset.screen;
                this.closeMoreSheet();
                this.showScreen(screen);
            });
        });

        // More sheet toggle
        const moreBtn = document.getElementById('dock-more');
        if (moreBtn) moreBtn.addEventListener('click', () => {
            if (!this._wasTap()) return;
            this.toggleMoreSheet();
        });

        // Close sheet on backdrop click
        const backdrop = document.querySelector('.more-sheet-backdrop');
        if (backdrop) backdrop.addEventListener('click', () => {
            if (!this._wasTap()) return;
            this.closeMoreSheet();
        });

        // Profile button in header
        document.getElementById('header-profile-btn').addEventListener('click', () => {
            if (!this._wasTap()) return;
            this.showScreen('profile');
        });
    },

    // True if the last touch was a tap (finger moved < 10px) or there was no touch.
    _wasTap() {
        // No touch ever seen yet -> assume mouse/desktop.
        if (this._lastTapAt < 0) return true;
        // A scroll happened recently (swipe gesture) -> definitely not a tap.
        if (Date.now() - this._lastScrollAt < 700) return false;
        // Synthetic clicks can be delayed and fire after the NEXT touchstart,
        // so check the snapshot taken at the producing touchend, not the live
        // _tapActive flag (which the next touch may have reset to true).
        return this._lastTapActive === true && Date.now() - this._lastTapAt < 700;
    },

    _captureTouchEnd(e) {
        // Double-check the finger actually stayed in place: a fast flick can be
        // coalesced into touchstart/touchend with no touchmove, so compare the
        // lifted position to where the touch began.
        if (e && e.changedTouches && e.changedTouches[0] && this._touchStart) {
            const t = e.changedTouches[0];
            const d = Math.hypot(t.clientX - this._touchStart.x, t.clientY - this._touchStart.y);
            if (d > 10) this._tapActive = false;
        }
        // Snapshot the tap state now; used by _wasTap() in click handlers.
        this._lastTapAt = Date.now();
        this._lastTapActive = this._tapActive;
        return this._tapActive;
    },

    toggleMoreSheet() {
        document.getElementById('more-sheet').classList.toggle('open');
    },

    closeMoreSheet() {
        document.getElementById('more-sheet').classList.remove('open');
    },

    showScreen(screen) {
        this.currentScreen = screen;
        this.closeMoreSheet();

        // Update dock
        document.querySelectorAll('.dock-item').forEach(item => {
            item.classList.toggle('active', item.dataset.screen === screen);
        });
        // Update more sheet items
        document.querySelectorAll('.more-item').forEach(item => {
            item.classList.toggle('active', item.dataset.screen === screen);
        });

        // Show screen
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(`screen-${screen}`);
        if (target) target.classList.add('active');

        // Cleanup intervals from previous screen
        if (this._refInterval) { clearInterval(this._refInterval); this._refInterval = null; }
        if (this._boostTimer) { clearInterval(this._boostTimer); this._boostTimer = null; }

        // Render screen content
        switch (screen) {
            case 'home': this.renderHome(); break;
            case 'upgrade': this.renderUpgrade(); break;
            case 'backgrounds': this.renderBackgrounds(); break;
            case 'boosts': this.renderBoostsShop(); break;
            case 'cases': this.renderCases(); break;
            case 'tasks': this.renderTasks(); break;
            case 'referrals': this.renderReferrals(); break;
            case 'leaderboard': this.renderLeaderboard(); break;
            case 'exchange': this.renderExchange(); break;
            case 'profile': this.renderProfile(); break;
        }
    },

    startIntervals() {
        // Energy regen (cosmetic ticker - server accrues authoritatively)
        if (this.energyInterval) clearInterval(this.energyInterval);
        this.energyInterval = setInterval(() => {
            if (!Auth.user) return;
            const regen = Auth.user.energy_regen || 1;
            const maxEnergy = Auth.user.max_energy || 1000;
            if (Auth.user.energy < maxEnergy) {
                Auth.user.energy = Math.min(Auth.user.energy + regen * 0.1, maxEnergy);
                this.updateEnergyUI();
            }
        }, 100);

        // Passive income: server-authoritative. Poll user every 10s so offline/
        // elapsed passive income accrues server-side and lands in the balance.
        if (this.passiveInterval) clearInterval(this.passiveInterval);
        this.passiveInterval = setInterval(() => {
            if (!Auth.user) return;
            // Snapshot optimistic totals before refreshUser replaces Auth.user.
            const prevCoins = Auth.user.coins || 0;
            const prevClicks = Auth.user.total_clicks || 0;
            const prevEarned = Auth.user.total_earned || 0;
            Auth.refreshUser().then((u) => {
                if (!u) return;
                this._confirmedCoins = u.coins || 0;
                this._confirmedClicks = u.total_clicks || 0;
                // Max-merge so a poll mid-hold never drops the counter/balance.
                u.coins = Math.max(u.coins || 0, prevCoins);
                u.total_clicks = Math.max(u.total_clicks || 0, prevClicks);
                u.total_earned = Math.max(u.total_earned || 0, prevEarned);
                this.updateBalanceUI();
                this.updateHeaderUI();
                this.updateEnergyUI();
                this.updateHomeStatsUI();
                if (this.currentScreen === 'home') this.renderHome();
            });
        }, 10000);

        // Real-time refresh: pick up admin edits/adds (tasks/levels/economy) live.
        if (this._cfgPoll) clearInterval(this._cfgPoll);
        this._cfgPoll = setInterval(() => this._refreshConfigLive(), 8000);
    },

    async _refreshConfigLive() {
        if (!Auth.user || !Auth.config) return;
        try {
            const res = await API.getConfig();
            if (!res || res.error) return;
            const before = JSON.stringify({ tasks: Auth.tasks, config: Auth.config });
            if (res.config) Auth.config = res.config;
            if (res.tasks) Auth.tasks = res.tasks;
            if (res.backgrounds) Auth.backgrounds = res.backgrounds;
            if (res.cases) Auth.cases = res.cases;
            const after = JSON.stringify({ tasks: Auth.tasks, config: Auth.config });
            if (before !== after) {
                this.updateAllUI();
                if (this.currentScreen === 'tasks') this.renderTasks();
                if (this.currentScreen === 'boosts') this.renderBoosts();
                if (this.currentScreen === 'cases') this.renderCases();
            }
        } catch (e) {}
    },

    // --- Online Counter ---
    startOnlineCounter() {
        this.updateOnlineCount();
        setInterval(() => this.updateOnlineCount(), 5000);
    },
    async _syncFromServer() {
        if (!Auth.user) return;
        // Snapshot the optimistic totals BEFORE refreshUser replaces Auth.user,
        // then merge with server truth using max() so the counter/balance never
        // jumps backwards mid-hold (phones fire focus/visibility a lot).
        const prevCoins = Auth.user.coins || 0;
        const prevClicks = Auth.user.total_clicks || 0;
        const prevEarned = Auth.user.total_earned || 0;
        const u = await Auth.refreshUser();
        if (!u) return;
        this._confirmedCoins = u.coins || 0;
        this._confirmedClicks = u.total_clicks || 0;
        u.coins = Math.max(u.coins || 0, prevCoins);
        u.total_clicks = Math.max(u.total_clicks || 0, prevClicks);
        u.total_earned = Math.max(u.total_earned || 0, prevEarned);
        this.updateBalanceUI();
        this.updateHeaderUI();
        this.updateEnergyUI();
        this.updateLevelProgressUI();
        this.updateHomeStatsUI();
    },
    async updateOnlineCount() {
        const res = await API.get('/api/online');
        if (res.online !== undefined) {
            const el = document.getElementById('header-online');
            const countEl = document.getElementById('header-online-count');
            if (el && countEl) {
                el.style.display = 'flex';
                countEl.textContent = res.online;
            }
        }
    },

    // --- Toast ---
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg>', error: '❌', info: 'ℹ️' };
        toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
        container.appendChild(toast);
        this._pruneToasts(container);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-20px)';
            setTimeout(() => toast.remove(), 300);
        }, 1800);
    },

    _pruneToasts(container) {
        const MAX = 3;
        while (container.children.length > MAX) {
            const old = container.firstChild;
            if (old) old.remove();
        }
    },

    showUpgradeNotification(key, fromLevel, toLevel) {
        const def = (Auth.config.upgrades || {})[key];
        const name = def ? def.name : key;
        const upgradeIcons = {
            click_power: 'icon-click', passive_income: 'icon-cash', max_energy: 'icon-battery',
            energy_regen: 'icon-lightning', lucky_click: 'icon-star', energy_save: 'icon-shield',
            click_combo: 'icon-cycle', crit_chance: 'icon-explosion', click_surge: 'icon-muscle',
            crit_damage: 'icon-target', energy_leech: 'icon-refresh', passive_mult: 'icon-chart',
            profit_mult: 'icon-dice'
        };
        const iconId = upgradeIcons[key] || 'icon-arrow-up';
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast success';
        toast.style.border = '1px solid rgba(0,255,136,0.2)';
        toast.style.background = 'linear-gradient(135deg, rgba(0,255,136,0.08), rgba(0,0,0,0.3))';
        toast.style.animation = 'toastUpgrade 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
        toast.innerHTML = `<span style="font-size:20px;"><svg class="icon" viewBox="0 0 24 24" style="width:22px;height:22px;"><use href="#${iconId}"/></svg></span><span><strong style="color:var(--gold);">${name}</strong> <span style="color:var(--success);">${fromLevel} → ${toLevel}</span></span>`;
        container.appendChild(toast);
        this._pruneToasts(container);
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(-30px) scale(0.9)'; setTimeout(() => toast.remove(), 300); }, 1300);
        
        // Add pulse animation to the upgrade card
        const cards = document.querySelectorAll('.upgrade-card');
        cards.forEach(c => {
            const nameEl = c.querySelector('.upgrade-name');
            if (nameEl && nameEl.textContent === name) {
                c.style.animation = 'upgradePulse 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
                c.style.borderColor = 'rgba(0,255,136,0.3)';
                setTimeout(() => { c.style.animation = ''; c.style.borderColor = ''; }, 600);
            }
        });
    },

    // --- Confirm Modal ---
    showConfirm(message) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modal-overlay');
            const body = document.getElementById('modal-body');
            body.innerHTML = `
                <button class="modal-close" onclick="document.getElementById('modal-overlay').classList.remove('active')">✕</button>
                <div class="modal-title" style="font-size:16px;">⚠️ Подтверждение</div>
                <div style="text-align:center;font-size:14px;color:var(--text-secondary);margin-bottom:20px;line-height:1.5;">${message}</div>
                <div style="display:flex;gap:10px;justify-content:center;">
                    <button class="exchange-btn" id="confirm-yes" style="background:var(--accent);color:#fff;border-color:var(--accent);padding:12px 28px;font-weight:700;"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg> Да</button>
                    <button class="exchange-btn" id="confirm-no" style="padding:12px 28px;">❌ Нет</button>
                </div>
            `;
            overlay.classList.add('active');
            document.getElementById('confirm-yes').onclick = () => { overlay.classList.remove('active'); resolve(true); };
            document.getElementById('confirm-no').onclick = () => { overlay.classList.remove('active'); resolve(false); };
        });
    },

    // --- Update UI ---
    async updateAllUI() {
        await Auth.refreshUser();
        this.updateHeaderUI();
        this.updateBalanceUI();
        this.updateEnergyUI();
        this.renderHome();
    },

    updateHeaderUI() {
        if (!Auth.user) return;
        const headerName = document.getElementById('header-name');
        const headerUsername = document.getElementById('header-username');
        const headerCoins = document.getElementById('header-coins');
        const headerAvatar = document.getElementById('header-avatar-img');
        const headerAvatarWrap = document.getElementById('header-avatar');

        if (Auth.user.is_admin) {
            headerName.innerHTML = `${Auth.user.first_name || 'User'} <img src="/assets/icons/admin.png" style="width:18px;height:18px;display:inline-block;vertical-align:middle;margin-left:4px;position:relative;top:-1px;">`;
        } else {
            headerName.textContent = Auth.user.first_name || 'User';
        }
        const allUsernames = Auth.user.username ? Auth.user.username.split(',').map(u => u.trim()).filter(Boolean) : [];
        headerUsername.textContent = allUsernames.length > 0 ? allUsernames.map(u => `@${u}`).join(', ') : '';
        headerCoins.textContent = Auth.formatNumber(Auth.user.coins || 0);
        
        const photo = Auth.user.photo_path || Auth.user.photo_url || '';
        const cacheBust = Auth.user.photo_file_id ? `?t=${encodeURIComponent(Auth.user.photo_file_id)}` : '';
        if (photo) {
            const newSrc = photo + cacheBust;
            if (headerAvatar.getAttribute('src') !== newSrc) {
                headerAvatar.src = newSrc;
            }
            headerAvatar.style.display = 'block';
        } else {
            headerAvatar.style.display = 'none';
            headerAvatarWrap.style.background = 'var(--accent-dim)';
            headerAvatarWrap.innerHTML = '<span style="font-size:18px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">👤</span>';
        }
    },

    _balanceAnimId: null,

    updateBalanceUI() {
        const el = document.getElementById('balance-amount');
        if (el && Auth.user) {
            this.animateCounter(el, Auth.user.coins || 0);
        }
        document.querySelectorAll('.coin-display').forEach(el => {
            if (Auth.user) el.textContent = Auth.formatNumber(Auth.user.coins);
        });
    },

    animateCounter(el, target) {
        if (this._shownBalance === undefined) this._shownBalance = target;
        const from = this._shownBalance;
        if (from === target) {
            el.textContent = Auth.formatNumber(target);
            return;
        }
        // If an animation is already running (rapid clicking), snap to the new
        // target instantly so the counter never lags behind the clicks.
        if (this._balanceAnimId) {
            this._shownBalance = target;
            el.textContent = Auth.formatNumber(target);
            return;
        }
        const start = performance.now();
        const duration = 180;
        const step = (now) => {
            const t = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            const val = Math.round(from + (target - from) * eased);
            this._shownBalance = val;
            el.textContent = Auth.formatNumber(val);
            if (t < 1) {
                this._balanceAnimId = requestAnimationFrame(step);
            } else {
                this._shownBalance = target;
                this._balanceAnimId = null;
            }
        };
        this._balanceAnimId = requestAnimationFrame(step);
    },

    updateHomeStatsUI() {
        if (!Auth.user) return;
        const clicksEl = document.getElementById('home-clicks');
        const passiveEl = document.getElementById('home-passive');
        const earnedEl = document.getElementById('home-total-earned');
        const clickPowerEl = document.getElementById('home-click-power');
        if (clicksEl) clicksEl.textContent = Auth.formatNumber(Auth.user.total_clicks || 0);
        if (passiveEl) passiveEl.textContent = Auth.formatNumber(Auth.calculatePassiveIncome());
        if (earnedEl) earnedEl.textContent = Auth.formatNumber(Auth.user.total_earned || 0);
        if (clickPowerEl) clickPowerEl.textContent = '+' + Auth.calculateClickReward();
    },

    updateEnergyUI() {
        if (!Auth.user) return;
        const current = Math.floor(Auth.user.energy || 0);
        const max = Auth.user.max_energy || 1000;
        const pct = Math.min((current / max) * 100, 100);
        const fill = document.getElementById('energy-fill');
        const text = document.getElementById('energy-text');
        if (fill) fill.style.width = `${pct}%`;
        if (text) text.textContent = `${current} / ${max}`;
        
        // Color based on level
        if (fill) {
            if (pct < 20) fill.style.background = 'linear-gradient(90deg, #EF4444, #F87171)';
            else if (pct < 50) fill.style.background = 'linear-gradient(90deg, #F59E0B, #FBBF24)';
            else fill.style.background = 'linear-gradient(90deg, var(--accent), var(--accent-hover))';
        }
    },

    // --- HOME SCREEN ---
    renderHome() {
        if (this.currentScreen !== 'home') return;
        if (!Auth.user) return;

        // Stats
        document.getElementById('home-level').textContent = `${Auth.user.level || 1}`;
        document.getElementById('home-level-name').textContent = Auth.getLevelName(Auth.user.level || 1);
        document.getElementById('home-clicks').textContent = Auth.formatNumber(Auth.user.total_clicks || 0);
        document.getElementById('home-passive').textContent = Auth.formatNumber(Auth.calculatePassiveIncome());
        const cp = Auth.calculateClickReward();
        const comboChance = Math.min((Auth.user.upgrades?.click_combo || 0) * (Auth.config?.upgrades?.click_combo?.effect_per_level || 2), 50);
        const critChance = Math.min((Auth.user.upgrades?.crit_chance || 0) * (Auth.config?.upgrades?.crit_chance?.effect_per_level || 3), 45);
        const cpw = document.getElementById('click-power-window');
        if (cpw) {
            cpw.querySelectorAll('.cpw-badge').forEach(b => b.remove());
            document.getElementById('home-click-power').textContent = '+' + cp;
            if (comboChance > 0) {
                const badge = document.createElement('span');
                badge.className = 'cpw-cell cpw-badge';
                badge.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><use href="#icon-cycle"/></svg>${comboChance}%`;
                cpw.appendChild(badge);
            }
            if (critChance > 0) {
                const badge = document.createElement('span');
                badge.className = 'cpw-cell cpw-badge cpw-crit';
                badge.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><use href="#icon-explosion"/></svg>${critChance}%`;
                cpw.appendChild(badge);
            }
        }
        document.getElementById('home-total-earned').textContent = Auth.formatNumber(Auth.user.total_earned || 0);
        document.getElementById('home-referrals').textContent = Auth.user.referral_count || 0;

        // Background bonus display
        const bgBonusEl = document.getElementById('home-bg-bonus');
        if (Auth.backgrounds && Auth.user.active_background) {
            const bg = Auth.backgrounds.find(b => b.id === Auth.user.active_background);
            if (bg) {
                bgBonusEl.innerHTML = `<span class="bonus-icon" style="background:rgba(79,143,255,0.15);"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-palette"/></svg></span><span>Фон <strong>"${bg.name}"</strong>: <strong style="color:var(--accent);">+${bg.bonus}%</strong> к доходу</span>`;
                bgBonusEl.classList.add('visible');
            } else {
                bgBonusEl.classList.remove('visible');
            }
        } else {
            bgBonusEl.classList.remove('visible');
        }

        // Active boosts display (live countdown)
        this.renderBoosts();
        if (this._boostTimer) clearInterval(this._boostTimer);
        this._boostTimer = setInterval(() => this.renderBoosts(), 1000);

        // Auto-clicker visual on coin
        const coinBtn = document.getElementById('click-button');
        let autoOverlay = coinBtn.querySelector('.auto-clicker-overlay');
        const activeBoosts = Auth.user.active_boosts || [];
        const validBoosts = activeBoosts.filter(b => b.expires_at > Date.now() / 1000);
        const hasAutoClicker = validBoosts.some(b => b.boost_id === 'auto_clicker');
        if (hasAutoClicker) {
            if (!autoOverlay) {
                autoOverlay = document.createElement('div');
                autoOverlay.className = 'auto-clicker-overlay';
                autoOverlay.innerHTML = '<div class="auto-clicker-hand"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-click"/></svg></div>';
                coinBtn.appendChild(autoOverlay);
            }
        } else {
            if (autoOverlay) autoOverlay.remove();
        }

        // Level progress
        const progress = Auth.getLevelProgress();
        const progressBar = document.getElementById('home-level-progress');
        if (progressBar) progressBar.style.width = `${progress * 100}%`;
        document.getElementById('home-level-name2').textContent = Auth.getLevelName(Auth.user.level || 1);

        this.updateEnergyUI();
    },

    renderBoosts() {
        if (!Auth.user) return;
        const boostEl = document.getElementById('home-boosts');
        if (!boostEl) return;
        const activeBoosts = Auth.user.active_boosts || [];
        const now = Date.now() / 1000;
        const validBoosts = activeBoosts.filter(b => b.expires_at > now);

        if (validBoosts.length > 0) {
            const boostDefs = (Auth.config && Auth.config.boosts) || [];
            let boostText = validBoosts.map(b => {
                const def = boostDefs.find(d => d.id === b.boost_id);
                const name = def ? def.name : 'Буст';
                const remaining = Math.max(0, Math.round(b.expires_at - now));
                const mins = Math.floor(remaining / 60);
                const secs = remaining % 60;
                const timeText = mins > 0 ? `${mins} мин${secs > 0 ? ' ' + secs + 'с' : ''}` : `${secs}с`;
                return `${name} <span style="color:var(--text-secondary);font-size:11px;">(${timeText})</span>`;
            }).join(', ');
            boostEl.innerHTML = `<span class="bonus-icon" style="background:rgba(255,215,0,0.15);"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-lightning"/></svg></span><span>Активные бонусы: <strong style="color:var(--gold);">${boostText}</strong></span>`;
            boostEl.classList.add('visible');
        } else {
            boostEl.classList.remove('visible');
        }
    },

    // --- BOOSTS SHOP ---
    renderBoostsShop() {
        if (this.currentScreen !== 'boosts') return;
        if (!Auth.config || !Auth.user) return;

        const boosts = (Auth.config.boosts) || [];
        const container = document.getElementById('boosts-list');
        if (!container) return;
        container.innerHTML = '';

        const now = Date.now() / 1000;
        const activeBoosts = Auth.user.active_boosts || [];
        const boostIcons = {
            coins_x2: 'icon-lightning',
            coins_x3: 'icon-lightning',
            coins_x5: 'icon-lightning',
            energy_full: 'icon-battery',
            auto_clicker: 'icon-click'
        };

        boosts.forEach(b => {
            const active = activeBoosts.find(x => x.boost_id === b.id && x.expires_at > now);
            const canAfford = Auth.user.coins >= b.price;

            const card = document.createElement('div');
            card.className = `boost-card ${active ? 'active' : ''}`;
            card.style.borderColor = active ? 'rgba(245,196,81,0.35)' : 'var(--glass-border)';

            let sub;
            if (b.id === 'energy_full') {
                sub = 'Мгновенно восстанавливает всю энергию';
            } else if (b.id === 'auto_clicker') {
                sub = 'Кликер работает автоматически';
            } else {
                sub = `x${b.multiplier} к доходу за клик`;
            }

            card.innerHTML = `
                <div class="boost-icon"><svg class="icon" viewBox="0 0 24 24"><use href="#${boostIcons[b.id] || 'icon-lightning'}"/></svg></div>
                <div class="boost-info">
                    <div class="boost-name">${b.name}</div>
                    <div class="boost-desc">${sub}</div>
                    ${b.duration ? `<div class="boost-duration"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-calendar"/></svg> ${b.duration} сек</div>` : ''}
                </div>
                <div class="boost-buy">
                    ${active ? `<div class="boost-active-tag">Активен</div>` : `
                    <div class="boost-price">${Auth.formatNumber(b.price)} <svg class="icon" viewBox="0 0 24 24"><use href="#icon-coin"/></svg></div>
                    <div class="boost-buy-btn">Купить</div>`}
                </div>
            `;

            if (!active) {
                card.addEventListener('click', () => this.handleBoostClick(b, canAfford));
            }
            container.appendChild(card);
        });
    },

    async handleBoostClick(boost, canAfford) {
        if (!Auth.user) return;
        if (!canAfford) {
            this.showToast(`Нужно ${Auth.formatNumber(boost.price)} монет!`, 'error');
            return;
        }

        const res = await API.buyBoost(boost.id);
        if (res.error) {
            this.showToast(res.error, 'error');
            return;
        }

        Auth.user.coins = res.coins;
        if (res.energy !== undefined) Auth.user.energy = res.energy;
        Auth.user.active_boosts = res.active_boosts || [];
        this.showToast(`${boost.name} активирован!`, 'success');
        this.updateAllUI();
        this.renderBoosts();
        this.renderBoostsShop();
    },

    // --- CLICKER ---
    setupClicker() {
        const btn = document.getElementById('click-button');
        let isHolding = false;
        let holdInterval = null;
        this._clickPending = false;
        this._clickQueue = 0;
        this._offlineUntil = 0;
        this._confirmedCoins = 0;
        this._confirmedClicks = 0;
        this._fxOn = true;

        const stopHold = () => {
            isHolding = false;
            if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
        };
        this.stopClickHold = stopHold;

        const playFx = () => {
            const btn = document.getElementById('click-button');
            if (!btn) return;
            const rect = btn.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            btn.style.transform = 'scale(0.92)';
            btn.style.transition = 'transform 0.1s cubic-bezier(0.34, 1.56, 0.64, 1)';
            setTimeout(() => { btn.style.transform = 'scale(1)'; }, 80);
            this.burstCoins(cx, cy, 5);
            this.spawnRipple(cx, cy);
            this.spawnFlyText(cx, cy, Auth.calculateClickReward());
        };

        const applyOptimistic = () => {
            if (!Auth.user) return;
            const estReward = Auth.calculateClickReward() || 1;
            Auth.user.coins = (Auth.user.coins || 0) + estReward;
            Auth.user.total_clicks = (Auth.user.total_clicks || 0) + 1;
            Auth.user.total_earned = (Auth.user.total_earned || 0) + estReward;
            this._lastReward = estReward;
            this.updateBalanceUI();
            this.updateHeaderUI();
            this.updateHomeStatsUI();
            if (Logger) Logger.click(estReward);
            // Visual feedback on EVERY tap, instantly (not after server reply)
            if (this._fxOn) playFx();
        };

        const startClick = () => {
            isHolding = true;
            this._clickQueue++;
            applyOptimistic();
            // Cooldown after a network failure: don't spam a dead server, but
            // ALWAYS show the optimistic counter feedback on every tap.
            if (Date.now() < this._offlineUntil) return;
            this.drainClickQueue();
            if (!holdInterval) {
                holdInterval = setInterval(() => {
                    if (isHolding) {
                        this._clickQueue++;
                        applyOptimistic();
                        if (Date.now() >= this._offlineUntil) this.drainClickQueue();
                    }
                }, 55);
            }
        };

        const stopClick = () => { stopHold(); };

        btn.addEventListener('mousedown', startClick);
        btn.addEventListener('mouseup', stopClick);
        btn.addEventListener('mouseleave', stopClick);
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startClick();
        }, { passive: false });
        btn.addEventListener('touchend', stopClick);
        btn.addEventListener('touchcancel', stopClick);
    },

    drainClickQueue() {
        if (this._clickPending || this._clickQueue <= 0) return;
        // Don't spam a dead server during the offline cooldown.
        if (Date.now() < this._offlineUntil) return;
        // Batch: gather all queued taps and send them as ONE network request.
        // The server processes the batch in a single file write, so a hold
        // burst (~15 taps/sec) no longer waits for one response per tap.
        // Keep a small gap between batches so the server anti-cheat (rejects
        // gaps < 50ms) never fires on rapid back-to-back sends.
        const now = Date.now();
        if (this._lastClickSent) {
            const wait = this._lastClickSent + 70 - now;
            if (wait > 0) {
                setTimeout(() => this.drainClickQueue(), wait);
                return;
            }
        }
        const batch = Math.min(this._clickQueue, 50);
        this._clickQueue -= batch;
        this._lastClickSent = Date.now();
        this.doClick(batch);
    },

    // Coin burst particles
    burstCoins(x, y, count = 6) {
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            el.className = 'coin-particle';
            const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.8;
            const dist = 35 + Math.random() * 55;
            el.style.setProperty('--bx', `${Math.cos(angle) * dist}px`);
            el.style.setProperty('--by', `${Math.sin(angle) * dist}px`);
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 1000);
        }
    },

    // Soft ripple ring on click
    spawnRipple(x, y) {
        const el = document.createElement('div');
        el.className = 'click-ripple-soft';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 800);
    },

    // Fly text
    spawnFlyText(x, y, text, extra = '') {
        const el = document.createElement('div');
        el.className = 'click-reward-fly';
        el.innerHTML = `+${text}${extra}`;
        el.style.left = `${x - 30 + Math.random() * 60}px`;
        el.style.top = `${y - 20}px`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 900);
    },

    async doClick(batch = 1) {
        // All queued taps already added their reward optimistically in startClick
        // (applyOptimistic). Here we only confirm/sync with the server, so rapid
        // taps show up on the balance instantly instead of one-by-one.
        if (this._clickPending) return;
        this._clickPending = true;
        try {
            // Send the whole batch in one request (single server write).
            const res = await API.click(batch);

            if (res.error) {
                if (Logger) Logger.api('POST', '/api/user/click', false, 0);
                // The failed clicks never counted: drop the optimistic taps.
                if (Auth.user) {
                    const estReward = this._lastReward || 1;
                    Auth.user.coins = Math.max((this._confirmedCoins || 0), (Auth.user.coins || 0) - estReward * batch);
                    Auth.user.total_clicks = Math.max((this._confirmedClicks || 0), (Auth.user.total_clicks || 0) - batch);
                    Auth.user.total_earned = Math.max((this._confirmedCoins || 0), (Auth.user.total_earned || 0) - estReward * batch);
                    this.updateBalanceUI();
                    this.updateHeaderUI();
                    this.updateHomeStatsUI();
                }
                if (res.network_error) {
                    // Server unreachable: stop SENDING for a short cooldown so we
                    // don't hammer a dead server. Keep the queued taps — they will
                    // be flushed once the cooldown passes.
                    this._offlineUntil = Date.now() + 3000;
                    if (this.stopClickHold) this.stopClickHold();
                    if (!this._offlineNotified) {
                        this._offlineNotified = true;
                        this.showToast('Нет соединения с сервером', 'error');
                    }
                }
                if (res.error.includes('энергии')) {
                    this.showToast('⚡ Недостаточно энергии!', 'error');
                }
                return;
            }

            // Sync confirmed totals; keep queued-but-not-yet-confirmed taps
            // optimistically on top so the number never jumps backwards.
            this._offlineUntil = 0;
            this._offlineNotified = false;
            this._confirmedCoins = res.coins;
            this._confirmedClicks = res.total_clicks;
            if (Logger) Logger.api('POST', '/api/user/click', true, 0);
            if (Logger) Logger.success(`Сервер подтвердил клики ×${batch}: +${res.reward} (баланс ${res.coins})`);
            if (Auth.user) {
                const estReward = this._lastReward || 1;
                Auth.user.coins = res.coins + this._clickQueue * estReward;
                Auth.user.total_clicks = res.total_clicks + this._clickQueue;
                Auth.user.total_earned = res.total_earned + this._clickQueue * estReward;
            }
            Auth.user.energy = res.energy;
            Auth.user.level = res.level;
            if (typeof res.total_earned === 'number') {
                Auth.user.total_earned = res.total_earned + this._clickQueue * (this._lastReward || 1);
            }

            // Update fly text with actual reward
            const flyEls = document.querySelectorAll('.click-reward-fly');
            const lastEl = flyEls[flyEls.length - 1];
            if (lastEl) {
                const isCrit = res.is_crit ? ' 💥' : '';
                const isCombo = res.is_combo ? ' x2' : '';
                const isLucky = res.is_lucky ? ' 🍀' : '';
                lastEl.innerHTML = `+${res.reward}${isCrit}${isCombo}${isLucky}`;
            }

            this.updateBalanceUI();
            this.updateHeaderUI();
            this.updateEnergyUI();
            this.updateLevelProgressUI();
            this.updateHomeStatsUI();
        } catch (e) {
            console.error('click error:', e);
            if (Auth.user) {
                const estReward = this._lastReward || 1;
                Auth.user.coins = Math.max((this._confirmedCoins || 0), (Auth.user.coins || 0) - estReward * batch);
                Auth.user.total_clicks = Math.max((this._confirmedClicks || 0), (Auth.user.total_clicks || 0) - batch);
                this.updateBalanceUI();
                this.updateHeaderUI();
                this.updateHomeStatsUI();
            }
        } finally {
            this._clickPending = false;
            // Flush any queued taps that arrived while the request was in flight
            setTimeout(() => this.drainClickQueue(), 0);
        }
    },

    updateLevelProgressUI() {
        if (!Auth.user) return;
        const progress = Auth.getLevelProgress();
        const bar = document.getElementById('home-level-progress');
        if (bar) bar.style.width = `${progress * 100}%`;
        const name2 = document.getElementById('home-level-name2');
        if (name2) name2.textContent = Auth.getLevelName(Auth.user.level || 1);
        const lvl = document.getElementById('home-level');
        if (lvl) lvl.textContent = Auth.user.level || 1;
        const lvlName = document.getElementById('home-level-name');
        if (lvlName) lvlName.textContent = Auth.getLevelName(Auth.user.level || 1);
        // Refresh the profile progress text too (if the profile screen is open)
        if (this.currentScreen === 'profile') this.renderProfile();
    },

    // --- UPGRADE SCREEN ---
    renderUpgrade() {
        if (this.currentScreen !== 'upgrade') return;
        if (!Auth.user || !Auth.config) return;

        const container = document.getElementById('upgrade-list');
        container.innerHTML = '';

        const upgrades = Auth.config.upgrades;
        const userUpgrades = Auth.user.upgrades || {};
        const icons = {
            click_power: 'icon-click', passive_income: 'icon-cash', max_energy: 'icon-battery',
            energy_regen: 'icon-lightning', lucky_click: 'icon-star', energy_save: 'icon-shield',
            click_combo: 'icon-cycle', crit_chance: 'icon-explosion', click_surge: 'icon-muscle',
            crit_damage: 'icon-target', energy_leech: 'icon-refresh', passive_mult: 'icon-chart',
            profit_mult: 'icon-dice'
        };
        const branchMeta = {
            click: { label: 'Сила клика', icon: 'icon-click', color: '#FF8C42', desc: 'Увеличивает награду за каждый клик' },
            energy: { label: 'Энергия', icon: 'icon-lightning', color: '#00FF88', desc: 'Больше запаса и восстановления энергии' },
            passive: { label: 'Доход', icon: 'icon-cash', color: '#4F8FFF', desc: 'Пассивный заработок и множители' }
        };

        const order = ['click', 'energy', 'passive'];

        order.forEach(branch => {
            const meta = branchMeta[branch];
            const branchKeys = Object.entries(upgrades).filter(([key, def]) => (def.branch || 'click') === branch);

            const header = document.createElement('div');
            header.className = 'upgrade-branch-header';
            header.style.setProperty('--branch-color', meta.color);
            header.innerHTML = `
                <span class="ubh-icon"><svg class="icon" viewBox="0 0 24 24"><use href="#${meta.icon}"/></svg></span>
                <div class="ubh-text">
                    <div class="ubh-title">${meta.label}</div>
                    <div class="ubh-desc">${meta.desc}</div>
                </div>
                <div class="ubh-line"></div>
            `;
            container.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'upgrade-grid';

            branchKeys.forEach(([key, def]) => {
                const currentLevel = userUpgrades[key] || 0;
                const maxLevel = def.max_level;
                const isMaxed = currentLevel >= maxLevel;

                // Prerequisite / locked state
                let locked = null;
                const requires = def.requires;
                if (requires) {
                    for (const [reqKey, reqLevel] of Object.entries(requires)) {
                        if ((userUpgrades[reqKey] || 0) < reqLevel) {
                            const reqDef = upgrades[reqKey];
                            locked = `Откроется после: ${reqDef ? reqDef.name : reqKey} ${reqLevel}+`;
                            break;
                        }
                    }
                }

                const cost = isMaxed ? 0 : this.getUpgradeCost(key, currentLevel);
                const canAfford = Auth.user.coins >= cost;

                const card = document.createElement('div');
                card.className = `upgrade-card ${locked ? 'locked' : (!canAfford && !isMaxed ? 'disabled' : '')} ${isMaxed ? 'maxed' : ''}`;

                const levelPct = maxLevel > 0 ? Math.round((currentLevel / maxLevel) * 100) : 0;
                const levelBarHtml = `<div class="upgrade-level-bar"><div class="upgrade-lvl-progress"><div class="upgrade-lvl-fill" style="width:${levelPct}%"></div></div></div>`;

                const reqHint = locked
                    ? `<div class="upgrade-lock-hint"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-lock"/></svg>${locked}</div>`
                    : '';

                card.innerHTML = `
                    <div class="upgrade-icon">${locked ? '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-lock"/></svg>' : `<svg class="icon" viewBox="0 0 24 24"><use href="#${icons[key] || 'icon-arrow-up'}"/></svg>`}</div>
                    <div class="upgrade-info">
                        <div class="upgrade-name">${def.name}</div>
                        <div class="upgrade-desc">${def.description}</div>
                        ${levelBarHtml}
                        ${reqHint}
                    </div>
                    <div class="upgrade-cost">
                        ${isMaxed ? '<div style="color:var(--success);font-size:13px;font-weight:600;">MAX</div>' : `
                            <div class="cost-amount">${Auth.formatNumber(cost)}</div>
                            <div class="cost-label">УР. ${currentLevel}/${maxLevel}</div>
                        `}
                    </div>
                `;

                if (!isMaxed && !locked) {
                    card.addEventListener('click', () => this.buyUpgrade(key));
                } else if (locked) {
                    card.addEventListener('click', () => this.showToast(locked, 'info'));
                }

                grid.appendChild(card);
            });

            container.appendChild(grid);
        });
    },

    getUpgradeCost(key, currentLevel) {
        if (!Auth.config || !Auth.config.upgrades) return 999999;
        const def = Auth.config.upgrades[key];
        if (!def) return 999999;
        return Math.floor(def.base_cost * Math.pow(def.cost_multiplier, currentLevel));
    },

    async buyUpgrade(key) {
        const res = await API.upgrade(key);
        if (res.error) {
            this.showToast(res.error, 'error');
            return;
        }
        const prevLevel = Auth.user.upgrades[key] || 0;
        Auth.user.coins = res.coins;
        Auth.user.upgrades[key] = res.upgrade_level;
        
        // Show upgrade toast with animation
        this.showUpgradeNotification(key, prevLevel, res.upgrade_level);
        
        // Apply effects locally
        const def = Auth.config.upgrades[key];
        const level = res.upgrade_level;
        const effect = def.effect_per_level;
        
        if (key === 'click_power') Auth.user.click_power = Auth.config.game.base_click_reward + level * effect;
        else if (key === 'passive_income') Auth.user.passive_income = level * effect;
        else if (key === 'max_energy') {
            Auth.user.max_energy = Auth.config.game.base_max_energy + level * effect;
        } else if (key === 'energy_regen') {
            Auth.user.energy_regen = Auth.config.game.base_energy_regen + level * effect;
        }
        // click_surge, crit_damage, energy_leech, passive_mult, profit_mult are
        // multiplier-type: read live from Auth.user.upgrades in auth.js calcs.

        this.updateAllUI();
        this.renderUpgrade();
    },

    // --- BACKGROUNDS SCREEN ---
    renderBackgrounds() {
        if (this.currentScreen !== 'backgrounds') return;
        if (!Auth.backgrounds || !Auth.user) return;

        const container = document.getElementById('backgrounds-list');
        container.innerHTML = '';

        Auth.backgrounds.forEach(bg => {
            const owned = Auth.user.backgrounds && Auth.user.backgrounds.includes(bg.id);
            const selected = Auth.user.active_background === bg.id;
            const canAfford = Auth.user.coins >= bg.price;

            const card = document.createElement('div');
            card.className = `bg-card ${selected ? 'selected' : ''} ${owned ? 'owned' : ''}`;
            card.style.backgroundImage = bg.svg_file ? `url('/assets/backgrounds/${bg.svg_file}')` : `linear-gradient(135deg, ${bg.color_start}, ${bg.color_end})`;
            card.style.backgroundSize = 'cover';
            card.style.backgroundPosition = 'center';
            card.style.border = selected ? `1px solid ${bg.accent}` : '';
            card.style.position = 'relative';
            
            const rarityLabels = { common: 'Обычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный' };
            const rarityKey = bg.rarity || 'common';

            card.innerHTML = `
                <span class="bg-badge badge-${rarityKey}">${rarityLabels[rarityKey] || rarityKey}</span>
                <div>
                    <div class="bg-name">${bg.name}</div>
                    <div class="bg-bonus">+${bg.bonus}% к доходу</div>
                    ${!owned ? `<div class="bg-price">${Auth.formatNumber(bg.price)} <svg class="icon" viewBox="0 0 24 24"><use href="#icon-coin"/></svg></div>` : 
                              `<div class="bg-price" style="color:var(--success);">${selected ? '✓ Активен' : '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-click"/></svg> Нажать для выбора'}</div>`}
                </div>
                <div style="position:absolute;bottom:8px;right:8px;font-size:24px;opacity:0.3;">
                    ${bg.accent ? '✦' : '●'}
                </div>
            `;

            card.addEventListener('click', () => this.handleBackgroundClick(bg.id, owned));
            container.appendChild(card);
        });
    },

    applyBackground() {
        if (!Auth.backgrounds || !Auth.user) return;
        const bgId = Auth.user.active_background;
        const body = document.body;
        body.classList.remove('bg-applied');
        
        // Ensure background layer exists
        let layer = document.getElementById('bg-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.id = 'bg-layer';
            layer.style.cssText = 'position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;';
            document.body.prepend(layer);
        }
        let overlay = document.getElementById('bg-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'bg-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
            layer.appendChild(overlay);
        }
        // Remove old bg animation
        const oldAnim = document.getElementById('bg-anim-style');
        if (oldAnim) oldAnim.remove();
        
        if (bgId) {
            const bg = Auth.backgrounds.find(b => b.id === bgId);
            if (bg) {
                // Reset body background (layer handles visuals now)
                body.style.background = 'var(--bg-primary)';
                body.style.backgroundImage = '';
                body.style.animation = 'none';

                // Animated SVG via <img> (CSS background-image does not run SMIL animations)
                // OR CSS-driven animated background layers
                layer.innerHTML = '';
                if (bg.css_animation) {
                    const cssLayer = document.createElement('div');
                    cssLayer.className = `bg-css bg-${bg.css_animation}`;
                    cssLayer.style.setProperty('--bg-start', bg.color_start || '#0a0a1a');
                    cssLayer.style.setProperty('--bg-end', bg.color_end || '#14142e');
                    cssLayer.style.setProperty('--bg-accent', bg.accent || '#4f8fff');
                    layer.appendChild(cssLayer);
                    layer.style.display = 'block';
                } else if (bg.svg_file) {
                    const img = document.createElement('img');
                    img.src = `/assets/backgrounds/${bg.svg_file}`;
                    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                    layer.appendChild(img);
                    layer.style.display = 'block';
                } else {
                    layer.style.display = 'none';
                }
                
                // Darkening overlay: strong at screen edges so backgrounds don't
                // overpower the clicker UI area in the center
                overlay.style.background = 'radial-gradient(ellipse 120% 90% at 50% 45%, rgba(6,8,16,0.35) 0%, rgba(6,8,16,0.62) 55%, rgba(4,5,12,0.92) 100%)';
                overlay.style.display = 'block';
                
                // Dynamic glow for click button
                const glow = document.getElementById('bg-accent-style') || document.createElement('style');
                glow.id = 'bg-accent-style';
                glow.textContent = `
                    .click-button { border-color: ${bg.accent}66; box-shadow: 0 0 60px ${bg.accent}18, inset 0 0 50px ${bg.accent}08, var(--shadow-md); }
                    .click-button:hover { box-shadow: 0 0 80px ${bg.accent}22, inset 0 0 50px ${bg.accent}08, var(--shadow-lg); }
                    .energy-bar-fill { background: linear-gradient(90deg, ${bg.accent}, ${bg.accent}cc, ${bg.accent}88); }
                `;
                document.head.appendChild(glow);
                
                body.classList.add('bg-applied');
                
                return;
            }
        }
        // Default: hide animated layer, show default gradient
        if (layer) layer.style.display = 'none';
        body.style.background = 'var(--bg-primary)';
        body.style.backgroundImage = 'radial-gradient(ellipse at 20% 50%, rgba(79, 143, 255, 0.04) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(139, 92, 246, 0.03) 0%, transparent 50%), radial-gradient(ellipse at 50% 80%, rgba(6, 182, 212, 0.02) 0%, transparent 50%)';
        body.style.animation = 'none';
        body.style.backgroundSize = '';
        const existing = document.getElementById('bg-accent-style');
        if (existing) existing.remove();
    },

    async handleBackgroundClick(bgId, owned) {
        if (!Auth.user) return;

        if (owned) {
            const res = await API.selectBackground(bgId);
            if (res.error) {
                this.showToast(res.error, 'error');
                return;
            }
            Auth.user.active_background = bgId;
            this.showToast('Фон выбран!', 'success');
            this.applyBackground();
        } else {
            const res = await API.buyBackground(bgId);
            if (res.error) {
                this.showToast(res.error, 'error');
                return;
            }
            Auth.user.coins = res.coins;
            Auth.user.backgrounds = res.backgrounds;
            this.showToast('Фон куплен!', 'success');
        }

        this.updateAllUI();
        this.renderBackgrounds();
    },

    // --- CASES SCREEN ---
    renderCases() {
        if (this.currentScreen !== 'cases') return;
        if (!Auth.cases) return;

        const container = document.getElementById('cases-list');
        container.innerHTML = '';

        Auth.cases.forEach(c => {
            const canAfford = Auth.user && Auth.user.coins >= c.price;

            const rarityLabels = { common: 'Обычный', uncommon: 'Необычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный' };
            const rarityColors = { common: '#7F8A99', uncommon: '#4F8FFF', rare: '#BF00FF', epic: '#00D4FF', legendary: '#FFD700' };
            const rarityColor = c.id === 'case_platinum' ? '#00E584' : (rarityColors[c.rarity] || '#7F8A99');

            const casePngs = { case_bronze: 'case_bronze.png', case_silver: 'case_silver.png', case_gold: 'case_gold.png', case_diamond: 'case_diamond.png', case_platinum: 'case_platinum.png' };
            const pngFile = casePngs[c.id];
            const hasPng = !!pngFile;

            const card = document.createElement('div');
            card.className = 'case-card-new';
            card.style.borderColor = `${rarityColor}25`;
            card.style.boxShadow = `0 0 30px ${rarityColor}08, var(--shadow-inner)`;

            card.innerHTML = `
                <div class="case-new-top">
                    <div class="case-new-icon" style="background:${rarityColor}18;">
                        ${hasPng ? `<div class="case-new-img-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;">...</div>` : `<span class="case-new-emoji"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-gift"/></svg></span>`}
                    </div>
                    <div class="case-new-info">
                        <div class="case-new-name">${c.name}</div>
                        <div class="case-new-meta">
                            <span class="case-new-tag" style="background:${rarityColor}20;color:${rarityColor};border-color:${rarityColor}30;font-weight:700;">${rarityLabels[c.rarity] || c.rarity}</span>
                            <span class="case-new-items">${c.items.length} предметов</span>
                        </div>
                    </div>
                </div>
                <div class="case-new-bottom">
                    <div class="case-new-price ${!canAfford ? 'nocan' : ''}">
                        <span class="case-new-price-icon"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-coin"/></svg></span>
                        ${Auth.formatNumber(c.price)}
                    </div>
                    <button class="case-new-btn ${!canAfford ? 'disabled' : ''}" data-case-id="${c.id}">
                        <span>${canAfford ? '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-dice"/></svg> Открыть' : 'Нужно больше'}</span>
                    </button>
                </div>
                <button class="case-new-chances" data-case-id="${c.id}"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-chart"/></svg> Шансы</button>
            `;

            const buyBtn = card.querySelector('.case-new-btn');
            buyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!canAfford) {
                    this.showToast(`Нужно ${Auth.formatNumber(c.price)} монет!`, 'error');
                    return;
                }
                const confirmed = await this.showConfirm(`Открыть кейс «${c.name}» за <strong style="color:var(--gold);">${Auth.formatNumber(c.price)}</strong> монет?`);
                if (!confirmed) return;
                buyBtn.innerHTML = '<span style="display:inline-block;animation:loadSpin 0.6s linear infinite;">⏳</span>';
                this.openCaseAnimation(c.id);
            });

            card.querySelector('.case-new-chances').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showCaseChances(c);
            });

            container.appendChild(card);

            if (hasPng) {
                const iconDiv = card.querySelector('.case-new-icon');
                const img = new Image();
                img.onload = () => {
                    iconDiv.innerHTML = `<img src="/assets/cases/${pngFile}" class="case-new-img" style="filter:drop-shadow(0 0 14px ${rarityColor}55);">`;
                };
                img.onerror = () => {
                    iconDiv.innerHTML = `<span class="case-new-emoji"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-gift"/></svg></span>`;
                };
                img.src = `/assets/cases/${pngFile}`;
            }
        });
    },

    showCaseChances(caseData) {
        const modal = document.getElementById('modal-overlay');
        const body = document.getElementById('modal-body');
        
        let itemsHtml = caseData.items.map((item, idx) => {
            const pct = (item.probability * 100).toFixed(1);
            const colors = ['#4F8FFF', '#10B981', '#F59E0B', '#EF4444', '#BF00FF', '#FFD700'];
            const barColor = colors[idx % colors.length];
            return `<div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                    <span>${item.name}</span>
                    <span style="font-weight:600;color:${barColor};">${pct}%</span>
                </div>
                <div style="width:100%;height:4px;background:rgba(0,0,0,0.3);border-radius:2px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px;box-shadow:0 0 8px ${barColor}44;"></div>
                </div>
            </div>`;
        }).join('');

        const col = caseData.color || '#4F8FFF';
        body.innerHTML = `
            <button class="modal-close" onclick="document.getElementById('modal-overlay').classList.remove('active')">✕</button>
            <div class="modal-title" style="color:${col};"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-chart"/></svg> ${caseData.name}</div>
            <div style="font-size:12px;color:var(--text-secondary);text-align:center;margin-bottom:16px;">
                Шансы выпадения предметов
            </div>
            ${itemsHtml}
        `;

        modal.classList.add('active');
    },

    hexToRgba(hex, alpha) {
        const h = (hex || '#ffffff').replace('#', '');
        const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        const n = parseInt(full, 16);
        if (isNaN(n)) return `rgba(255,255,255,${alpha})`;
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    },

    buildCaseRays(col) {
        const c = this.hexToRgba(col, 0.5);
        const c2 = this.hexToRgba(col, 0.2);
        const el = document.createElement('div');
        el.className = 'case-rays';
        el.style.background = `conic-gradient(from 0deg, ${c} 0deg, transparent 30deg, ${c2} 65deg, transparent 95deg, ${c} 130deg, transparent 160deg, ${c2} 195deg, transparent 225deg, ${c} 260deg, transparent 290deg, ${c2} 325deg, transparent 355deg, ${c} 360deg)`;
        return el;
    },

    spawnCaseFlash(col) {
        const overlay = document.getElementById('case-animation');
        if (!overlay) return;
        const el = document.createElement('div');
        el.className = 'case-flash';
        el.style.background = `radial-gradient(circle, ${this.hexToRgba(col, 0.9)} 0%, ${this.hexToRgba(col, 0.25)} 45%, transparent 72%)`;
        overlay.appendChild(el);
        setTimeout(() => el.remove(), 600);
    },

    spawnCaseBurst(col, x, y) {
        const overlay = document.getElementById('case-animation');
        if (!overlay) return;
        const colors = [col, this.hexToRgba(col, 0.6), '#FFFFFF', '#FFD700'];
        for (let i = 0; i < 22; i++) {
            const el = document.createElement('div');
            el.className = 'case-burst-particle';
            const angle = Math.random() * Math.PI * 2;
            const dist = 70 + Math.random() * 160;
            el.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
            el.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
            el.style.background = colors[i % colors.length];
            el.style.boxShadow = `0 0 14px ${this.hexToRgba(col, 0.7)}`;
            el.style.borderRadius = Math.random() > 0.5 ? '50%' : '3px';
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            overlay.appendChild(el);
            setTimeout(() => el.remove(), 850);
        }
    },

    spawnCaseFloatParticles(col, count = 16) {
        const overlay = document.getElementById('case-animation');
        if (!overlay) return;
        const container = overlay.querySelector('.case-open-container');
        if (!container) return;
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            el.className = 'case-float-particle';
            el.style.left = `${15 + Math.random() * 70}%`;
            el.style.top = `${25 + Math.random() * 55}%`;
            el.style.background = [col, '#FFD700', '#FFFFFF'][i % 3];
            el.style.boxShadow = `0 0 10px ${this.hexToRgba(col, 0.8)}`;
            el.style.animationDelay = `${Math.random() * 2.4}s`;
            el.style.animationDuration = `${2 + Math.random() * 1.8}s`;
            container.appendChild(el);
        }
    },

    async openCaseAnimation(caseId) {
        const overlay = document.getElementById('case-animation');
        overlay.innerHTML = '';
        overlay.className = 'case-slot-overlay';
        overlay.classList.add('active');

        const caseDef = Auth.cases.find(c => c.id === caseId);
        if (!caseDef) { overlay.classList.remove('active'); return; }

        const rarityColors = { common: '#7F8A99', uncommon: '#4F8FFF', rare: '#BF00FF', epic: '#00D4FF', legendary: '#FFD700' };
        const col = caseDef.id === 'case_platinum' ? '#00E584' : (rarityColors[caseDef.rarity] || '#4F8FFF');

        // Pick reward from server immediately (authoritative)
        const res = await API.openCase(caseId);
        if (res.error) {
            overlay.classList.remove('active');
            this.showToast(res.error, 'error');
            return;
        }

        Auth.user.coins = res.coins;
        Auth.user.cases_opened = res.total_cases;
        this.updateAllUI();

        const finalReward = res.reward;
        const emojiMap = { coins: 'icon-coin', boost: 'icon-lightning', energy: 'icon-battery', background: 'icon-palette' };
        const rewardAmount = finalReward.type === 'coins' ? Auth.formatNumber(finalReward.amount) : '';

        const cellIcon = (type) => `<svg class="icon" viewBox="0 0 24 24"><use href="#${emojiMap[type] || 'icon-gift'}"/></svg>`;

        // --- Build slot strip ---
        const CELL = 96;
        const items = caseDef.items;
        const beforeCount = 14;
        const afterCount = 10;
        const chosenIndex = beforeCount;
        const stripCells = [];

        for (let i = 0; i < beforeCount; i++) {
            stripCells.push(items[Math.floor(Math.random() * items.length)]);
        }
        stripCells.push({ type: finalReward.type, name: finalReward.name, chosen: true });
        // Cells after the winner keep the strip "flowing" past the arrow
        for (let i = 0; i < afterCount; i++) {
            stripCells.push(items[Math.floor(Math.random() * items.length)]);
        }

        const strip = document.createElement('div');
        strip.className = 'slot-strip';
        strip.style.transform = 'translateX(0px)';

        stripCells.forEach((cell) => {
            const el = document.createElement('div');
            el.className = `slot-cell ${cell.chosen ? 'chosen' : ''}`;
            el.innerHTML = `
                <span class="slot-cell-icon">${cellIcon(cell.type)}</span>
                <span class="slot-cell-name">${cell.name}</span>
            `;
            el.style.width = `${CELL}px`;
            strip.appendChild(el);
        });

        overlay.appendChild(this.buildCaseRays(col));
        overlay.innerHTML += `
            <div class="slot-roll-container">
                <div class="case-open-title">${caseDef.name}</div>
                <div class="slot-indicator"><div class="slot-indicator-arrow"></div></div>
                <div class="slot-window" id="slot-window">
                    <div class="slot-payline"></div>
                    <div class="slot-shade slot-shade-left"></div>
                    <div class="slot-shade slot-shade-right"></div>
                    <div class="slot-fade slot-fade-left"></div>
                    <div class="slot-fade slot-fade-right"></div>
                    <div id="slot-strip-wrap" class="slot-strip-wrap">${strip.outerHTML}</div>
                </div>
                <div class="case-open-status" id="case-open-status"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-dice"/></svg> Крутим...</div>
            </div>
        `;

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const stripEl = document.getElementById('slot-strip-wrap').firstElementChild;
        const statusEl = document.getElementById('case-open-status');

        const rect = document.getElementById('slot-window').getBoundingClientRect();
        const burstX = rect.left + rect.width / 2;
        const burstY = rect.top + rect.height / 2;

        await sleep(450);

        // --- Spin with deceleration to land on the chosen cell ---
        statusEl.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-cycle"/></svg> <span style="color:' + col + ';font-weight:700;">Крутим барабан...</span>';
        // Use the cell's real rendered position (cells have horizontal margins,
        // so a fixed CELL constant would land the winner off-center).
        const chosenCell = stripEl.querySelector('.slot-cell.chosen');
        const cellCenter = chosenCell ? chosenCell.offsetLeft + chosenCell.offsetWidth / 2 : chosenIndex * CELL + CELL / 2;
        const target = cellCenter - rect.width / 2;
        stripEl.style.transition = 'transform 4.2s cubic-bezier(0.10, 0.85, 0.12, 1)';
        stripEl.style.transform = `translateX(${-target}px)`;

        // Optional: little tick while spinning
        let tick = 0;
        const tickInterval = setInterval(() => {
            statusEl.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-cycle"/></svg> <span style="color:' + col + ';font-weight:700;">Крутим барабан' + '.'.repeat(tick % 4) + '</span>';
            tick++;
        }, 260);

        await sleep(4300);
        clearInterval(tickInterval);

        // --- Reveal: flash + reward card ---
        this.spawnCaseFlash(col);
        this.spawnCaseBurst(col, burstX, burstY);
        this.createConfetti();

        const rewardAmountText = rewardAmount ? `<div class="case-open-reward-amount" style="color:${col};">+${rewardAmount}</div>` : '';
        overlay.innerHTML = '';
        overlay.appendChild(this.buildCaseRays(col));
        overlay.querySelector('.case-rays').classList.add('case-rays-reward');
        overlay.innerHTML += `
            <div class="case-open-container">
                <div class="case-open-reward-card" style="border-color:${this.hexToRgba(col, 0.4)}; --ray-color:${this.hexToRgba(col, 0.8)}; box-shadow:0 0 90px ${this.hexToRgba(col, 0.22)}, var(--glass-inner);">
                    <div class="case-open-reward-icon" style="color:${col};">${cellIcon(finalReward.type)}</div>
                    <div class="case-open-reward-name" style="background:linear-gradient(135deg,#fff,${col});-webkit-background-clip:text;-webkit-text-fill-color:transparent;">${finalReward.name}</div>
                    ${rewardAmountText}
                    <div class="case-open-reward-desc">
                        ${finalReward.type === 'coins' ? 'монет' :
                          finalReward.type === 'boost' ? `Буст на ${finalReward.duration} сек` :
                          finalReward.type === 'energy' ? `+${Auth.formatNumber(finalReward.amount)} энергии` :
                          finalReward.type === 'background' ? 'Новый фон добавлен!' : ''}
                    </div>
                    <button class="claim-btn" onclick="document.getElementById('case-animation').classList.remove('active'); App.renderCases();">
                        <svg class="icon" viewBox="0 0 24 24"><use href="#icon-gift"/></svg> Забрать
                    </button>
                </div>
            </div>
        `;
        this.spawnCaseFloatParticles(col);
    },

    createConfetti() {
        const colors = ['#4F8FFF', '#FFD700', '#FF6B6B', '#10B981', '#BF00FF', '#FF8C00'];
        for (let i = 0; i < 30; i++) {
            const piece = document.createElement('div');
            piece.className = 'confetti-piece';
            piece.style.left = `${Math.random() * 100}vw`;
            piece.style.top = `${Math.random() * 50 + 30}vh`;
            piece.style.background = colors[Math.floor(Math.random() * colors.length)];
            piece.style.animationDelay = `${Math.random() * 0.5}s`;
            piece.style.animationDuration = `${1 + Math.random() * 0.5}s`;
            document.body.appendChild(piece);
            setTimeout(() => piece.remove(), 2000);
        }
    },

    // --- TASKS SCREEN ---
    formatTaskReward(task) {
        const r = task.reward;
        if (r && typeof r === 'object') {
            const type = r.type || 'coins';
            if (type === 'boost') {
                const name = r.name || r.boost_id || 'буст';
                const mins = r.duration ? Math.max(1, Math.round(r.duration / 60)) : 0;
                return `Буст «${name}»${mins ? ` на ${mins} мин` : ''}`;
            }
            if (type === 'voucher') {
                return `🎟 Ваучер на ${Auth.formatNumber(r.amount)} Robux`;
            }
            if (r.min !== undefined && r.max !== undefined && r.max > r.min) {
                return `${Auth.formatNumber(r.min)}-${Auth.formatNumber(r.max)} монет`;
            }
            return `${Auth.formatNumber(r.amount)} монет`;
        }
        return `${Auth.formatNumber(r)} монет`;
    },

    renderTasks() {
        if (this.currentScreen !== 'tasks') return;
        if (!Auth.tasks || !Auth.user) return;

        const container = document.getElementById('tasks-list');
        container.innerHTML = '';

        const completed = Auth.user.completed_tasks || [];

        Auth.tasks.forEach(task => {
            if (!task.enabled) return;
            const isCompleted = completed.includes(task.id);
            
            const card = document.createElement('div');
            card.className = `task-card ${isCompleted ? 'completed' : ''}`;

            const icons = {
                telegram: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-send"/></svg>', referral: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-people"/></svg>', level: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-star"/></svg>', clicks: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-click"/></svg>',
                earn: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-coin"/></svg>', purchase_case: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-gift"/></svg>', upgrade_count: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-arrow-up"/></svg>', daily: '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-calendar"/></svg>'
            };

            card.innerHTML = `
                <div class="task-icon">${icons[task.type] || '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-scroll"/></svg>'}</div>
                <div class="task-info">
                    <div class="task-title">${task.title}</div>
                    <div class="task-desc">${task.description}</div>
                    ${this.taskChannelNamesHtml(task)}
                    <div class="task-reward">+${this.formatTaskReward(task)}</div>
                </div>
                ${isCompleted ? '<span class="task-status">✓ Выполнено</span>' :
                 this.taskActionHtml(task)}
            `;

            if (!isCompleted) {
                const btn = card.querySelector('.task-action-btn');
                btn.addEventListener('click', () => this.taskAction(task));
            }

            container.appendChild(card);
        });
    },

    taskChannelNamesHtml(task) {
        if (task.type !== 'telegram' || !Array.isArray(task.channels)) return '';
        const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
        const names = task.channels.map(c => c.label || 'Telegram-канал').filter(Boolean);
        if (!names.length) return '';
        return `<div class="task-channels">📢 ${names.map(escH).join(' • ')}</div>`;
    },

    taskActionHtml(task) {
        if (task.type === 'telegram') {
            const started = this.isTaskStarted(task.id);
            return started
                ? '<button class="task-action-btn verify" data-task-id="' + task.id + '">Проверить</button>'
                : '<button class="task-action-btn" data-task-id="' + task.id + '">Выполнить</button>';
        }
        return '<button class="task-action-btn" data-task-id="' + task.id + '">Выполнить</button>';
    },

    isTaskStarted(taskId) {
        try {
            const arr = JSON.parse(localStorage.getItem('started_tasks') || '[]');
            return Array.isArray(arr) && arr.includes(taskId);
        } catch (e) { return false; }
    },

    setTaskStarted(taskId) {
        try {
            let arr = JSON.parse(localStorage.getItem('started_tasks') || '[]');
            if (!Array.isArray(arr)) arr = [];
            if (!arr.includes(taskId)) arr.push(taskId);
            localStorage.setItem('started_tasks', JSON.stringify(arr));
        } catch (e) {}
    },

    async taskAction(task) {
        if (task.type === 'telegram' && !this.isTaskStarted(task.id)) {
            this.setTaskStarted(task.id);
            if (task.channels && task.channels.length) this.navigateTaskLink(task.channels[0].url);
            this.renderTasks();
            this.showToast('Подпишись на канал, затем нажми «Проверить»', 'info');
            return;
        }
        await this.completeTask(task.id);
    },

    navigateTaskLink(link) {
        if (!link) return;
        const lg = window.Telegram && window.Telegram.WebApp;
        if (lg && lg.openTelegramLink && (/t\.me\/|telegram\.me\//).test(link)) {
            lg.openTelegramLink(link);
        } else {
            window.open(link, '_blank');
        }
    },

    async completeTask(taskId) {
        const task = Auth.tasks.find(t => t.id === taskId);
        if (!task) return;

        const res = await API.completeTask(taskId);
        if (res.error) {
            this.showToast(res.error, 'error');
            return;
        }

        Auth.user.coins = res.coins;
        Auth.user.completed_tasks = res.completed_tasks;
        this.showToast(`Задание выполнено! +${this.formatTaskReward(task)}`, 'success');
        this.updateAllUI();
        this.renderTasks();
    },

    // --- REFERRALS SCREEN ---
    getReferralLink() {
        // Client-side fallback: build from bot username + referral code even if
        // the server response is slow or the field is missing.
        if (Auth.user && Auth.user.referral_code && Auth.config && Auth.config.bot_username) {
            return `https://t.me/${Auth.config.bot_username}?start=${Auth.user.referral_code}`;
        }
        return '';
    },

    async copyText(text) {
        // 1) Modern async clipboard (secure context)
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (e) { /* fall through */ }
        }
        // 2) Legacy execCommand fallback (works on many mobile webviews)
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) return true;
        } catch (e) { /* fall through */ }
        // 3) Prompt the link so the user can copy manually
        try { prompt('Скопируй ссылку:', text); } catch (e) {}
        return false;
    },

    async renderReferrals() {
        if (this.currentScreen !== 'referrals') return;
        if (!Auth.user) return;

        const fallbackLink = this.getReferralLink();
        const linkEl = document.getElementById('ref-link');
        if (fallbackLink && linkEl && linkEl.textContent === 'Загрузка...') {
            linkEl.textContent = fallbackLink;
        }

        // Poll referral data every 3s for real-time updates
        if (this._refInterval) clearInterval(this._refInterval);
        const doRefresh = async () => {
            const res = await API.getReferralInfo();
            const link = (res && res.referral_link) || fallbackLink;
            if (res && !res.error && res.referral_link) {
                document.getElementById('ref-link').textContent = res.referral_link;
            } else if (link && linkEl) {
                document.getElementById('ref-link').textContent = link;
            }
            if (res && res.referral_count !== undefined) {
                document.getElementById('ref-count').textContent = res.referral_count;
                document.getElementById('ref-active').textContent = res.referral_active_count || 0;
                document.getElementById('ref-earned').textContent = Auth.formatNumber(res.referral_earned || 0);
            }
            // Sync balance/referral data in memory so coins appear without page reload
            if (res && typeof res.coins === 'number') {
                Auth.user.coins = res.coins;
                Auth.user.total_earned = res.total_earned;
                Auth.user.referral_count = res.referral_count;
                Auth.user.referral_active_count = res.referral_active_count;
                Auth.user.referral_earned = res.referral_earned;
                this.updateBalanceUI();
                this.updateHeaderUI();
                // Only notify when a new referral actually joined
                const prevCount = this._refPrevCount !== undefined ? this._refPrevCount : (res.referral_count || 0);
                this._refPrevCount = res.referral_count || 0;
                if ((res.referral_count || 0) > prevCount) {
                    this.showToast('Новый реферал присоединился!', 'success');
                }
            }
        };
        await doRefresh();
        this._refInterval = setInterval(doRefresh, 3000);

        // Copy link
        document.getElementById('ref-copy-btn').onclick = async () => {
            const text = document.getElementById('ref-link').textContent || fallbackLink;
            const ok = await this.copyText(text);
            if (ok) this.showToast('Ссылка скопирована!', 'success');
        };

        // Share link via Telegram's native share, letting the user pick a friend
        // and send a pre-filled nice message (keeps the Mini App alive).
        const shareBtn = document.getElementById('ref-share-btn');
        if (shareBtn) {
            shareBtn.style.display = '';
            shareBtn.onclick = async () => {
                const link = document.getElementById('ref-link').textContent || fallbackLink;
                const gameName = (Auth.config && Auth.config.game_name) || 'Clicker Farm';
                const msg = `🔥 Присоединяйся ко мне в ${gameName}! Жми по ссылке, начни играть и зарабатывай монеты 🪙`;
                const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(msg)}`;
                const lg = window.Telegram && window.Telegram.WebApp;
                if (lg && lg.openTelegramLink) {
                    lg.openTelegramLink(shareUrl);
                    return;
                }
                if (navigator.share) {
                    try { await navigator.share({ title: gameName, text: msg, url: link }); return; }
                    catch (e) { /* cancelled or unsupported */ }
                }
                window.open(shareUrl, '_blank');
            };
        }
    },

    // --- LEADERBOARD ---
    _lbCache: {},

    async renderLeaderboard(sortType) {
        if (this.currentScreen !== 'leaderboard') return;
        
        const sort = sortType || 'total_earned';

        // Render cached data instantly if available
        if (this._lbCache[sort]) {
            this._renderLeaderboardList(this._lbCache[sort], sort);
        } else {
            const container = document.getElementById('leaderboard-list');
            if (container) container.innerHTML = '<div class="text-center" style="color:var(--text-secondary);padding:40px;">Загрузка...</div>';
        }

        // Fetch fresh data in background
        const res = await API.getLeaderboard(sort);
        if (res.error) return;
        this._lbCache[sort] = res.leaderboard || [];
        this._renderLeaderboardList(this._lbCache[sort], sort);
    },

    _renderLeaderboardList(leaderboard, sort) {
        const container = document.getElementById('leaderboard-list');
        if (!container) return;
        container.innerHTML = '';

        // Tabs
        document.querySelectorAll('.lb-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.sort === sort);
        });

        leaderboard.forEach((entry, i) => {
            const rank = i + 1;
            const rankClass = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';

            const item = document.createElement('div');
            item.className = 'lb-item';
            const rankImg = rank === 1 ? '/assets/ranks/top1.png' : rank === 2 ? '/assets/ranks/top2.png' : rank === 3 ? '/assets/ranks/top3.png' : null;
            const avatarSrc = entry.photo_path || entry.photo_url || '';
            const avatarEl = avatarSrc
                ? `<img src="${avatarSrc}" alt="">`
                : '<span style="font-size:20px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">👤</span>';
            const adminBadge = entry.is_admin
                ? ' <img src="/assets/icons/admin.png" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-left:4px;position:relative;top:-1px;">'
                : '';
            const titleBadge = entry.custom_title
                ? `<img src="/assets/title/${entry.custom_title}" style="position:absolute;bottom:-2px;right:-3px;width:18px;height:18px;z-index:10;border-radius:50%;background:var(--bg);">`
                : '';
            item.innerHTML = `
                <div class="lb-rank ${rankClass}">${rankImg ? `<img src="${rankImg}" class="lb-rank-img">` : rank}</div>
                <div class="lb-avatar" style="position:relative;">
                    ${avatarEl}
                    ${titleBadge}
                </div>
                <div class="lb-name">${entry.first_name || entry.username || 'User'}${adminBadge}</div>
                <div class="lb-score">
                    ${sort === 'referral_count' ? `${entry.referral_count} <svg class="icon" viewBox="0 0 24 24"><use href="#icon-people"/></svg>` : `${Auth.formatNumber(entry.total_earned)} <svg class="icon" viewBox="0 0 24 24"><use href="#icon-coin"/></svg>`}
                </div>
            `;
            container.appendChild(item);
        });

        if (leaderboard.length === 0) {
            container.innerHTML = '<div class="text-center" style="color:var(--text-secondary);padding:40px;">Пока нет участников</div>';
        }
    },

    // --- EXCHANGE SCREEN ---
    async renderExchange() {
        if (this.currentScreen !== 'exchange') return;
        if (!Auth.user) return;

        // User info
        document.getElementById('exchange-balance').textContent = Auth.formatNumber(Auth.user.coins || 0);
        document.getElementById('exchange-today').textContent = `${Auth.user.exchange_count_today || 0}/${Auth.config.game.max_exchange_per_day || 5}`;
        document.getElementById('exchange-total').textContent = Auth.formatNumber(Auth.user.total_exchanged || 0);

        const res = await API.getAvailableVouchers();
        if (res.error) return;

        const container = document.getElementById('exchange-options');
        container.innerHTML = '';

        const options = res.options || [];
        options.forEach(opt => {
            const canAfford = Auth.user.coins >= opt.price_coins;
            const hasStock = opt.available > 0;
            const canExchange = canAfford && hasStock && (Auth.user.exchange_count_today || 0) < (Auth.config.game.max_exchange_per_day || 5);

            const card = document.createElement('div');
            card.className = 'exchange-card';
            card.innerHTML = `
                <div class="exchange-left">
                    <div class="exchange-amount">${opt.amount} Robux</div>
                    <div class="exchange-label">В наличии: ${opt.available} шт.</div>
                </div>
                <div style="text-align:right;">
                    <div class="exchange-price">${Auth.formatNumber(opt.price_coins)} <svg class="icon" viewBox="0 0 24 24"><use href="#icon-coin"/></svg></div>
                    <button class="exchange-btn" ${!canExchange ? 'disabled' : ''} data-amount="${opt.amount}">
                        ${!canAfford ? 'Нужно больше' : !hasStock ? 'Нет в наличии' : 'Обменять'}
                    </button>
                </div>
            `;

            const btn = card.querySelector('.exchange-btn');
            if (canExchange) {
                btn.addEventListener('click', () => this.doExchange(opt.amount));
            }

            container.appendChild(card);
        });

        if (options.length === 0) {
            container.innerHTML = '<div class="text-center" style="color:var(--text-secondary);padding:40px;">Скоро появятся ваучеры для обмена</div>';
        }
    },

    async doExchange(amount) {
        // Show confirmation modal instead of confirm()
        const cost = amount * Auth.config.game.exchange_rate;
        const confirmed = await this.showConfirm(`Обменять ${Auth.formatNumber(cost)} монет на <strong>${amount} Robux</strong> ваучер?`);
        if (!confirmed) return;

        const res = await API.exchange(amount);
        if (res.error) {
            this.showToast(res.error, 'error');
            return;
        }

        Auth.user.coins = res.coins;
        Auth.user.total_exchanged = res.total_exchanged;
        Auth.user.exchange_count_today = res.exchange_count_today;

        // Show voucher
        this.showToast(`Ваучер получен! Код: ${res.voucher_code}`, 'success');
        this.createConfetti();
        this.updateAllUI();
        this.renderExchange();
    },

    // --- PROFILE SCREEN ---
    _getRankProgress(user) {
        const totalEarned = user.total_earned || 0;
        const levels = (Auth.config && Auth.config.levels) || [];
        const level = user.level || 1;
        const current = levels.find(l => l.level === level);
        const next = levels.find(l => l.level === level + 1);
        if (!current) {
            return { pct: 1, earned: totalEarned, needed: totalEarned };
        }
        if (!next) {
            // Max level reached
            return { pct: 1, earned: totalEarned, needed: totalEarned };
        }
        const earned = Math.max(0, totalEarned - (current.coins_needed || 0));
        const needed = Math.max(1, (next.coins_needed || 0) - (current.coins_needed || 0));
        return { pct: Math.min(earned / needed, 1), earned, needed };
    },

    async renderProfile() {
        if (this.currentScreen !== 'profile') return;
        if (!Auth.user) return;

        // Force re-sync profile from Telegram (bio/name/username)
        await Auth.refreshUser(true);

        // Avatar
        const avatar = document.getElementById('profile-avatar-img');
        const avatarRing = document.querySelector('.profile-avatar');
        // Check local avatar first
        const localAvatar = `/assets/avatars/avatar_${Auth.user.id}.jpg`;
        const localAvatarPng = `/assets/avatars/avatar_${Auth.user.id}.png`;
        
        avatar.onerror = function() {
            this.style.display = 'none';
            if (avatarRing) {
                avatarRing.style.background = 'var(--accent-dim)';
                avatarRing.innerHTML = '<span style="font-size:28px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">👤</span>';
            }
        };
        
        const cacheBust = Auth.user.photo_file_id ? `?t=${encodeURIComponent(Auth.user.photo_file_id)}` : '';
        if (Auth.user.photo_path) {
            avatar.src = Auth.user.photo_path + cacheBust;
            avatar.style.display = 'block';
        } else if (Auth.user.photo_url) {
            avatar.src = Auth.user.photo_url + cacheBust;
            avatar.style.display = 'block';
        } else {
            avatar.src = localAvatar + cacheBust;
            avatar.style.display = 'block';
        }
        
        // Name
        const nameEl = document.getElementById('profile-name');
        nameEl.textContent = Auth.user.first_name || 'User';
        
        // Username(s) display
        const usernameEl = document.getElementById('profile-username-list');
        const usernames = Auth.user.username ? Auth.user.username.split(',').map(u => u.trim()).filter(Boolean) : [];
        if (usernames.length > 0) {
            usernameEl.innerHTML = usernames.map(u => `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px;font-size:13px;"><svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px;color:var(--accent);"><use href="#icon-send"/></svg> @${u}</span>`).join('');
        } else {
            usernameEl.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">Нет username</span>';
        }
        
        // Bio
        const bioEl = document.getElementById('profile-bio');
        if (Auth.user.bio) {
            bioEl.textContent = Auth.user.bio;
        } else {
            bioEl.innerHTML = '<span style="color:var(--text-muted);font-style:italic;">Нет информации о себе</span>';
        }
        
        // Track / host info
        const trackEl = document.getElementById('profile-track');
        const hostInfo = Auth.user.host || Auth.user.referred_by || '';
        if (hostInfo) {
            trackEl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="width:12px;height:12px;color:#FFD700;"><use href="#icon-target"/></svg> id: ${hostInfo}`;
            trackEl.style.display = 'flex';
        } else {
            trackEl.style.display = 'none';
        }
        
        // Music (if available in user data)
        const musicEl = document.getElementById('profile-music');
        if (Auth.user.music) {
            musicEl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="width:12px;height:12px;color:var(--gold);"><use href="#icon-music"/></svg> ${Auth.user.music}`;
            musicEl.style.display = 'flex';
        } else {
            musicEl.style.display = 'none';
        }

        // Balance row
        document.getElementById('profile-total-earned').textContent = Auth.formatNumber(Auth.user.total_earned || 0);
        document.getElementById('profile-total-clicks').textContent = Auth.formatNumber(Auth.user.total_clicks || 0);
        document.getElementById('profile-click-power').textContent = Auth.calculateClickReward();
        document.getElementById('profile-energy-max').textContent = Auth.user.max_energy || 1000;

        // Stats block
        document.getElementById('profile-referrals').textContent = Auth.user.referral_count || 0;
        document.getElementById('profile-referral-earned').textContent = Auth.formatNumber(Auth.user.referral_earned || 0);
        document.getElementById('profile-cases').textContent = Auth.user.cases_opened || 0;
        document.getElementById('profile-exchanged').textContent = Auth.formatNumber(Auth.user.total_exchanged || 0);

        // Rank panel
        const level = Auth.user.level || 1;
        const rankName = Auth.getLevelName(level);
        document.getElementById('profile-rank-level-num').textContent = level;
        document.getElementById('profile-rank-name').textContent = rankName;
        const rankLevelFiles = { 1: 'novice.png', 2: 'explorer.png', 3: 'miner.png', 4: 'farmer.png', 5: 'magnate.png', 6: 'investor.png', 7: 'millionaire.png', 8: 'legend.png', 9: 'king.png', 10: 'god.png' };
        const rankFile = rankLevelFiles[level] || 'novice.png';
        document.getElementById('profile-rank-img').src = `/assets/ranks/levels/${rankFile}`;
        document.getElementById('profile-rank-badge').src = `/assets/ranks/levels/${rankFile}`;

        // Rank progress to next level
        const rankProgress = this._getRankProgress(Auth.user);
        const rankFill = document.getElementById('profile-rank-fill');
        if (rankFill) rankFill.style.width = `${Math.round(rankProgress.pct * 100)}%`;
        const rankEarned = document.getElementById('profile-rank-earned');
        if (rankEarned) rankEarned.textContent = Auth.formatNumber(rankProgress.earned);
        const rankNeeded = document.getElementById('profile-rank-needed');
        if (rankNeeded) rankNeeded.textContent = Auth.formatNumber(rankProgress.needed);

        // Header level progress
        const headerProgress = Auth.getLevelProgress();
        const headerFill = document.getElementById('profile-level-fill');
        if (headerFill) headerFill.style.width = `${Math.round(headerProgress * 100)}%`;
        const headerText = document.getElementById('profile-level-progress-text');
        if (headerText) headerText.textContent = `${Math.round(headerProgress * 100)}% до уровня ${level + 1}`;
        
        // Custom title badge replaces rank badge (bottom-right)
        const rankBadge = document.getElementById('profile-rank-badge');
        const customTitle = Auth.user.custom_title || '';
        let titleImg = document.querySelector('.profile-custom-title');
        if (customTitle) {
            if (!titleImg) {
                titleImg = document.createElement('img');
                titleImg.className = 'profile-custom-title';
                titleImg.style.cssText = 'position:absolute;bottom:-4px;right:-6px;width:40px;height:40px;object-fit:contain;z-index:10;filter:drop-shadow(0 0 14px rgba(214,163,93,0.5));';
                document.querySelector('.profile-avatar-ring').appendChild(titleImg);
            }
            titleImg.src = `/assets/title/${customTitle}`;
            titleImg.style.display = 'block';
            if (rankBadge) rankBadge.style.display = 'none';
        } else {
            if (titleImg) titleImg.style.display = 'none';
            if (rankBadge) rankBadge.style.display = 'block';
        }

        // Exchange history
        const historyEl = document.getElementById('profile-exchange-history');
        const history = Auth.user.exchange_history || [];
        if (history.length > 0) {
            historyEl.innerHTML = history.slice(-5).reverse().map(h => `
                <div>
                    <span style="color:var(--text-secondary);font-size:12px;">${h.date}</span>
                    <span style="color:var(--accent);font-weight:600;font-size:13px;">${h.amount} Robux</span>
                </div>
            `).join('');
        } else {
            historyEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:8px;font-size:12px;">Нет операций</div>';
        }

        // Completed tasks
        const tasksEl = document.getElementById('profile-tasks');
        const completed = Auth.user.completed_tasks || [];
        tasksEl.textContent = `${completed.length}/${(Auth.tasks || []).filter(t => t.enabled).length}`;
    },

    // --- LOGOUT ---
    logout() {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/';
    },

    // --- Browser fallback for the auth screen (dev / non-Telegram) ---
    // If run inside Telegram this shouldn't be reached; try one more auto-login
    // instead of opening a link (which would collapse the Mini App).
    openTelegramMiniApp() {
        if (this.inTelegram()) {
            this.tryTelegramLogin().then((ok) => { if (ok) window.location.reload(); });
            return;
        }
        alert('Эта игра работает внутри Telegram. Откройте её через кнопку меню бота.');
    }
};

// --- Particle System ---
const Particles = {
    canvas: null,
    ctx: null,
    particles: [],
    animFrame: null,
    
    init() {
        this.canvas = document.getElementById('particle-canvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());
        // Pause the animation loop when the tab is hidden to save CPU/battery.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (this.animFrame) { cancelAnimationFrame(this.animFrame); this.animFrame = null; }
            } else if (!this.animFrame) {
                this.animate();
            }
        });
        this.createParticles();
        this.animate();
    },
    
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    },
    
    createParticles() {
        this.particles = [];
        const isMobile = window.innerWidth <= 768;
        const count = isMobile ? 16 : Math.min(60, Math.floor(window.innerWidth * 0.05));
        for (let i = 0; i < count; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3,
                r: Math.random() * 2 + 0.5,
                alpha: Math.random() * 0.4 + 0.1,
                color: ['rgba(79,143,255,', 'rgba(139,92,246,', 'rgba(6,182,212,', 'rgba(236,72,153,'][Math.floor(Math.random() * 4)],
                glow: !isMobile
            });
        }
    },
    
    animate() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            
            if (p.x < 0) p.x = this.canvas.width;
            if (p.x > this.canvas.width) p.x = 0;
            if (p.y < 0) p.y = this.canvas.height;
            if (p.y > this.canvas.height) p.y = 0;
            
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            this.ctx.fillStyle = p.color + p.alpha + ')';
            this.ctx.fill();
            
            // Glow (skipped on mobile: halves the fill count)
            if (p.glow) {
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
                this.ctx.fillStyle = p.color + (p.alpha * 0.15) + ')';
                this.ctx.fill();
            }
        });
        
        this.animFrame = requestAnimationFrame(() => this.animate());
    }
};

// --- Utility ---
Auth.formatNumber = function(num) {
    if (num === undefined || num === null) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return Math.floor(num).toString();
};

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    // Setup leaderboard tabs
    document.querySelectorAll('.lb-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            App.renderLeaderboard(tab.dataset.sort);
        });
    });

    // Setup modal close
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.target.classList.remove('active');
        }
    });

    // Setup copy referral link
    document.getElementById('ref-link').addEventListener('click', function() {
        navigator.clipboard.writeText(this.textContent).then(() => {
            App.showToast('Ссылка скопирована!', 'success');
        });
    });

    await App.init();
});
