const PLAN_CATEGORY = {
    MOVIE: 'movie',
    DESI: 'desi',
    NON_DESI: 'non_desi',
    GENERAL: 'general',
};

const normalizePlanCategory = (value) => {
    const normalized = String(value || PLAN_CATEGORY.GENERAL).toLowerCase().replace(/[-\s]/g, '_');
    if (Object.values(PLAN_CATEGORY).includes(normalized)) {
        return normalized;
    }
    return PLAN_CATEGORY.GENERAL;
};

const getGroupIdForCategory = (category) => {
    const normalized = normalizePlanCategory(category);

    const mapping = {
        [PLAN_CATEGORY.MOVIE]: process.env.MOVIE_PREMIUM_GROUP_ID,
        [PLAN_CATEGORY.DESI]: process.env.DESI_PREMIUM_GROUP_ID,
        [PLAN_CATEGORY.NON_DESI]: process.env.NON_DESI_PREMIUM_GROUP_ID,
        [PLAN_CATEGORY.GENERAL]: process.env.PREMIUM_GROUP_ID,
    };

    return mapping[normalized] || process.env.PREMIUM_GROUP_ID || null;
};

const getAllPremiumGroupIds = () => {
    const values = [
        process.env.MOVIE_PREMIUM_GROUP_ID,
        process.env.DESI_PREMIUM_GROUP_ID,
        process.env.NON_DESI_PREMIUM_GROUP_ID,
        process.env.PREMIUM_GROUP_ID,
    ].filter(Boolean);

    return [...new Set(values.map(v => String(v)))];
};

module.exports = {
    PLAN_CATEGORY,
    normalizePlanCategory,
    getGroupIdForCategory,
    getAllPremiumGroupIds,
};
