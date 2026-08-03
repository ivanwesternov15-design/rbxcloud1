const Auth = {
    user: null,
    config: null,
    backgrounds: null,
    cases: null,
    tasks: null,
    isAuthenticated: false,

    async init() {
        API.init();
        const token = API.getToken();
        if (!token) {
            this.isAuthenticated = false;
            return false;
        }

        // Load config
        const configRes = await API.getConfig();
        if (configRes.error) {
            this.isAuthenticated = false;
            return false;
        }

        this.config = configRes.config;
        this.backgrounds = configRes.backgrounds;
        this.cases = configRes.cases;
        this.tasks = configRes.tasks;

        // Load user
        const userRes = await API.getUser();
        if (userRes.error || !userRes.user) {
            this.isAuthenticated = false;
            localStorage.removeItem('session_token');
            localStorage.removeItem('user_id');
            return false;
        }

        this.user = userRes.user;
        this.isAuthenticated = true;
        return true;
    },

    async refreshUser(forceSync = false) {
        const res = await API.getUser(forceSync);
        if (res.user) {
            this.user = res.user;
        }
        return this.user;
    },

    getLevelName(level) {
        if (!this.config || !this.config.levels) return `Уровень ${level}`;
        const lvl = this.config.levels.find(l => l.level === level);
        return lvl ? lvl.name : `Уровень ${level}`;
    },

    getLevelBonus(level) {
        if (!this.config || !this.config.levels) return 1;
        const lvl = this.config.levels.find(l => l.level === level);
        return lvl ? lvl.bonus : 1;
    },

    getLevelProgress() {
        if (!this.user || !this.config) return 0;
        const totalEarned = this.user.total_earned || 0;
        const levels = this.config.levels || [];
        const currentLevel = this.user.level || 1;
        
        const current = levels.find(l => l.level === currentLevel);
        const next = levels.find(l => l.level === currentLevel + 1);
        
        if (!current || !next) return 1;
        
        const earned = totalEarned - current.coins_needed;
        const needed = next.coins_needed - current.coins_needed;
        return Math.min(earned / needed, 1);
    },

    calculatePassiveIncome() {
        if (!this.user) return 0;
        const upgrades = (this.config && this.config.upgrades) || {};
        let rate = this.user.passive_income || 0;

        // Profit synergy: +X% to all income
        const profitLevel = (this.user.upgrades && this.user.upgrades.profit_mult) || 0;
        rate *= 1 + profitLevel * (upgrades.profit_mult ? upgrades.profit_mult.effect_per_level : 2) / 100;

        // Level bonus
        rate *= this.getLevelBonus(this.user.level || 1);

        // Background bonus
        if (this.backgrounds && this.user.active_background) {
            const bg = this.backgrounds.find(b => b.id === this.user.active_background);
            if (bg) rate *= (1 + bg.bonus / 100);
        }

        return rate;
    },

    calculateClickReward() {
        if (!this.user) return 1;
        const upgrades = (this.config && this.config.upgrades) || {};
        const level = this.user.level || 1;

        const baseReward = (this.config && this.config.game && this.config.game.base_click_reward) || 1;
        const clickPowerLevel = (this.user.upgrades && this.user.upgrades.click_power) || 0;
        const clickPowerBonus = clickPowerLevel * (upgrades.click_power ? upgrades.click_power.effect_per_level : 1);
        let reward = baseReward + clickPowerBonus;

        // Profit synergy
        const profitLevel = (this.user.upgrades && this.user.upgrades.profit_mult) || 0;
        reward *= 1 + profitLevel * (upgrades.profit_mult ? upgrades.profit_mult.effect_per_level : 2) / 100;

        reward *= this.getLevelBonus(level);

        if (this.backgrounds && this.user.active_background) {
            const bg = this.backgrounds.find(b => b.id === this.user.active_background);
            if (bg) reward *= (1 + bg.bonus / 100);
        }

        const boostMult = this.user.boost_multiplier || 1;
        reward *= boostMult;

        return Math.round(reward);
    }
};
