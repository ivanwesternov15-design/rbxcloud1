const API = {
    _token: null,
    _baseUrl: window.location.origin,
    _timeoutMs: 12000,

    init() {
        this._token = localStorage.getItem('session_token');
    },

    getToken() {
        return this._token;
    },

    async _fetch(url, opts, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || this._timeoutMs);
        try {
            return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
        } finally {
            clearTimeout(timer);
        }
    },

    async get(endpoint, params = {}, timeoutMs) {
        if (this._token) params.token = this._token;
        const query = Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
        const url = `${this._baseUrl}${endpoint}${query ? '?' + query : ''}`;
        try {
            const res = await this._fetch(url, {
                headers: { 'Authorization': this._token || '' }
            }, timeoutMs);
            return await res.json();
        } catch (e) {
            console.error('API GET error:', e);
            return { network_error: true, error: e.name === 'AbortError' ? 'Таймаут запроса' : 'Нет соединения с сервером' };
        }
    },

    async post(endpoint, data = {}, timeoutMs) {
        if (this._token) data.token = this._token;
        try {
            const res = await this._fetch(`${this._baseUrl}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }, timeoutMs);
            return await res.json();
        } catch (e) {
            console.error('API POST error:', e);
            return { network_error: true, error: e.name === 'AbortError' ? 'Таймаут запроса' : 'Нет соединения с сервером' };
        }
    },

    // User
    async getUser(forceSync = false) {
        const params = forceSync ? { force: 1 } : {};
        return await this.get('/api/user/get', params);
    },

    async click(count = 1) {
        return await this.post('/api/user/click', { count }, 5000);
    },

    async upgrade(upgradeKey) {
        return await this.post('/api/user/upgrade', { upgrade: upgradeKey });
    },

    async buyBackground(bgId) {
        return await this.post('/api/user/buy_background', { background_id: bgId });
    },

    async selectBackground(bgId) {
        return await this.post('/api/user/select_background', { background_id: bgId });
    },

    async setTitle(title) {
        return await this.post('/api/user/set_title', { title });
    },

    async buyBoost(boostId) {
        return await this.post('/api/user/buy_boost', { boost_id: boostId });
    },

    async openCase(caseId) {
        return await this.post('/api/user/open_case', { case_id: caseId });
    },

    async completeTask(taskId) {
        return await this.post('/api/user/complete_task', { task_id: taskId });
    },

    async exchange(amount) {
        return await this.post('/api/user/exchange', { amount });
    },

    async getReferralInfo() {
        return await this.get('/api/user/referral_info');
    },

    async getRobuxStatus() {
        return await this.get('/api/user/robux_status');
    },

    async withdraw(amount, roblox_username) {
        return await this.post('/api/user/withdraw', { amount, roblox_username });
    },

    async readAdminMessage(message_id) {
        return await this.post('/api/user/message_read', { message_id });
    },

    async adminRobuxWithdraw() {
        return await this.post('/api/admin/robux_withdraw_status', {});
    },

    async adminToggleRobuxWithdraw(enabled) {
        return await this.post('/api/admin/toggle_robux_withdraw', { enabled });
    },

    async adminSetWithdrawal(user_id, withdrawal_id, status) {
        return await this.post('/api/admin/set_withdrawal', { user_id, withdrawal_id, status });
    },

    async adminSendMessage(user_id, text, title) {
        return await this.post('/api/admin/send_message', { user_id, text, title });
    },

    async getConfig() {
        return await this.get('/api/config');
    },

    async getLeaderboard(sort = 'total_earned') {
        return await this.get('/api/leaderboard', { sort });
    },

    async getAvailableVouchers() {
        return await this.get('/api/vouchers/available');
    },

    // Admin
    async adminCheck() {
        return await this.post('/api/admin/check');
    },

    async adminGetUsers() {
        return await this.post('/api/admin/users');
    },

    async adminToggleBlock(userId) {
        return await this.post('/api/admin/toggle_block', { user_id: userId });
    },

    async adminSetBalance(userId, balance) {
        return await this.post('/api/admin/set_balance', { user_id: userId, balance });
    },

    async adminSetUserFields(userId, fields) {
        return await this.post('/api/admin/set_user_fields', Object.assign({ user_id: userId }, fields));
    },

    async adminGetVouchers() {
        return await this.post('/api/admin/vouchers');
    },

    async adminAddVoucher(amount, code) {
        return await this.post('/api/admin/add_voucher', { amount, code });
    },

    async adminAddVouchersBulk(count, amount) {
        return await this.post('/api/admin/add_vouchers_bulk', { count, amount });
    },

    async adminUpdateConfig(config) {
        return await this.post('/api/admin/update_config', { config });
    },

    async adminSaveTasks(tasks) {
        return await this.post('/api/admin/save_tasks', { tasks });
    },

    async adminSaveCases(cases) {
        return await this.post('/api/admin/save_cases', { cases });
    },

    async adminSaveBackgrounds(backgrounds) {
        return await this.post('/api/admin/save_backgrounds', { backgrounds });
    },

    async adminListTitles() {
        return await this.post('/api/admin/list_titles', {});
    },

    async adminSetTitle(userId, title) {
        return await this.post('/api/admin/set_title', { user_id: userId, title });
    },

    async gateCheck() {
        return await this.post('/api/user/gate_check', {});
    },

    async ticketsList() {
        return await this.get('/api/tickets/list');
    },

    async ticketCreate(category, subject, message) {
        return await this.post('/api/tickets/create', { category, subject, message });
    },

    async ticketRespond(number, message) {
        return await this.post('/api/tickets/respond', { number, message });
    },

    async ticketRate(number, rating) {
        return await this.post('/api/tickets/rate', { number, rating });
    },

    async ticketCancel(number) {
        return await this.post('/api/tickets/cancel', { number });
    }
};
